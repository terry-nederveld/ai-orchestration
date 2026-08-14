/**
 * CopilotAgentProvider: AgentProvider backed by the GitHub Copilot CLI
 * (`copilot -p "<prompt>" --allow-all-tools`). Deliberately the simplest of
 * the three agent adapters: the CLI's headless output is a plain text
 * stream with no structured tool-call events, so this adapter reports
 * agent.text only — no agent.tool.started/completed, no turn boundaries,
 * no usage accounting (the CLI does not emit token/cost figures), and no
 * resume support (the CLI exposes no session-resume flag in this mode).
 * Event granularity is intentionally coarse; prefer Claude Code or Codex
 * when structured tool visibility matters.
 */

import { execFile } from 'node:child_process'
import {
  type AgentEvent,
  type AgentGoal,
  type AgentProvider,
  type AgentResult,
  type AgentRunHandle,
  type AgentRunRequest,
  Capability,
  CapabilitySet,
  OrchestratorError,
  type ProviderAvailability,
  type ProviderInfo,
} from '@overture/core'
import { AsyncQueue } from '@overture/runtime'
import { sandboxedEnv } from '@overture/tools'
import { defaultSpawner, type Spawner } from './process.js'

export type CopilotAuth =
  | { readonly kind: 'cli-session' }
  | { readonly kind: 'api-key'; readonly apiKey: () => Promise<string | undefined> }

export interface CopilotAgentProviderOptions {
  readonly auth: CopilotAuth
  readonly binary?: string
  readonly extraArgs?: readonly string[]
  /** Injectable for tests; defaults to a real `spawn` of `binary`. */
  readonly spawner?: Spawner
  /** Injectable for tests; defaults to `execFile`-based `copilot --version`. */
  readonly versionRunner?: (binary: string) => Promise<string>
}

const defaultVersionRunner = (binary: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { shell: false }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })

const MAX_TAIL_CHARS = 4000

function tailSummary(output: string, fallback: string): string {
  const trimmed = output.trim()
  if (!trimmed) return fallback
  return trimmed.length > MAX_TAIL_CHARS ? trimmed.slice(-MAX_TAIL_CHARS) : trimmed
}

function composePrompt(goal: AgentGoal): string {
  const parts = [goal.role ? `[role: ${goal.role}]\n${goal.goal}` : goal.goal]
  if (goal.context) parts.push('', '## Context', goal.context)
  return parts.join('\n')
}

export class CopilotAgentProvider implements AgentProvider {
  readonly info: ProviderInfo = {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    kind: 'agent',
    consumption: 'subscription',
    authentication: ['api-key', 'cli-session'],
  }

  private readonly auth: CopilotAuth
  private readonly binary: string
  private readonly extraArgs: readonly string[]
  private readonly spawner: Spawner
  private readonly versionRunner: (binary: string) => Promise<string>

  constructor(options: CopilotAgentProviderOptions) {
    this.auth = options.auth
    this.binary = options.binary ?? 'copilot'
    this.extraArgs = options.extraArgs ?? []
    this.spawner = options.spawner ?? defaultSpawner
    this.versionRunner = options.versionRunner ?? defaultVersionRunner
  }

  capabilities(): CapabilitySet {
    // Conservative on purpose: the CLI does use tools and does stream
    // output, but this adapter cannot observe individual tool calls (the
    // output is unstructured text), so it does not claim ToolUse/
    // ParallelToolUse/ResumeSession here.
    return CapabilitySet.of(Capability.Chat, Capability.Streaming)
  }

  async detect(): Promise<ProviderAvailability> {
    try {
      const version = await this.versionRunner(this.binary)
      if (this.auth.kind === 'api-key') {
        const key = await this.auth.apiKey()
        return {
          installed: true,
          authenticated: key !== undefined,
          available: key !== undefined,
          authenticationKind: 'api-key',
          detail: version,
        }
      }
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: 'cli-session',
        detail: version,
      }
    } catch (error) {
      return {
        installed: false,
        authenticated: false,
        available: false,
        authenticationKind: this.auth.kind,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const env = await this.resolveEnv()
    const prompt = composePrompt(request.goal)
    const args = ['-p', prompt, '--allow-all-tools', '--no-color', ...this.extraArgs]
    const startedAt = Date.now()

    const child = this.spawner(this.binary, args, {
      ...(request.workspace?.path !== undefined ? { cwd: request.workspace.path } : {}),
      env,
    })

    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ type: 'agent.started', sessionId: request.sessionId })

    let cancelRequested = false
    let timedOut = false
    let stdoutBuffer = ''
    let stderrBuffer = ''

    let settle: (result: AgentResult) => void = () => {}
    const resultPromise = new Promise<AgentResult>((resolve) => {
      settle = resolve
    })

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdoutBuffer += text
      queue.push({ type: 'agent.text', text })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-MAX_TAIL_CHARS)
    })

    const finish = (code: number | null) => {
      const usage = {
        provider: 'copilot',
        tokens: { inputTokens: 0, outputTokens: 0 },
        durationMs: Date.now() - startedAt,
        turns: 1,
        subagents: 0,
      }

      let result: AgentResult
      if (cancelRequested) {
        result = { outcome: 'CANCELLED', summary: 'Copilot run was cancelled', usage }
      } else if (timedOut) {
        result = {
          outcome: 'BUDGET_EXHAUSTED',
          summary: 'Copilot run exceeded its wall-clock timeout',
          usage,
        }
      } else if (code === 0) {
        result = {
          outcome: 'GOAL_COMPLETED',
          summary: tailSummary(stdoutBuffer, 'Copilot run completed'),
          usage,
        }
      } else {
        result = {
          outcome: 'FATAL_FAILURE',
          summary: tailSummary(
            stderrBuffer,
            tailSummary(stdoutBuffer, `copilot exited with code ${code}`),
          ),
          usage,
        }
      }

      queue.push({ type: 'agent.completed', result })
      queue.close()
      settle(result)
    }

    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      const result: AgentResult = {
        outcome: 'FATAL_FAILURE',
        summary: `failed to start copilot: ${error.message}`,
        usage: {
          provider: 'copilot',
          tokens: { inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - startedAt,
          turns: 0,
          subagents: 0,
        },
      }
      queue.push({ type: 'agent.completed', result })
      queue.close()
      settle(result)
    })

    const timer =
      request.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, request.timeoutMs)
        : undefined

    void resultPromise.finally(() => {
      if (timer) clearTimeout(timer)
    })

    return {
      sessionId: request.sessionId,
      events: () => queue,
      result: () => resultPromise,
      cancel: async () => {
        cancelRequested = true
        child.kill('SIGKILL')
      },
    }
  }

  private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
    // Allowlisted base only (ADR-0016): the daemon's ambient environment is
    // never inherited. HOME stays so the gh/Copilot stored session resolves;
    // an ambient GH_TOKEN/COPILOT_GITHUB_TOKEN is deliberately NOT inherited
    // — configure token auth explicitly instead.
    if (this.auth.kind === 'api-key') {
      const token = await this.auth.apiKey()
      if (!token) throw new OrchestratorError('GitHub Copilot token not configured', 'auth-expired')
      return sandboxedEnv({ COPILOT_GITHUB_TOKEN: token })
    }
    return sandboxedEnv()
  }
}
