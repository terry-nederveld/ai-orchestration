/**
 * CodexAgentProvider: AgentProvider backed by the Codex CLI, driven headlessly
 * via `codex exec --json` (argument-array spawn, JSONL on stdout). No
 * `@openai/codex-sdk` dependency — the CLI is driven directly for zero-dep
 * control over env, argv, and process lifecycle.
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
import {
  type CodexEvent,
  type CodexItem,
  type CodexUsage,
  isAgentMessageItem,
  isCodexEvent,
} from './codex-types.js'
import { JsonlSplitter } from './jsonl.js'
import { fromItemEvent, toUsageRecord } from './mapping.js'
import { defaultSpawner, type Spawner } from './process.js'

export type CodexAuth =
  | { readonly kind: 'cli-session' }
  | { readonly kind: 'api-key'; readonly apiKey: () => Promise<string | undefined> }

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexAgentProviderOptions {
  readonly auth: CodexAuth
  readonly binary?: string
  readonly sandboxMode?: CodexSandboxMode
  readonly extraArgs?: readonly string[]
  /** Injectable for tests; defaults to a real `spawn` of `binary`. */
  readonly spawner?: Spawner
  /** Injectable for tests; defaults to `execFile`-based `codex <args>`. */
  readonly runner?: (args: readonly string[]) => Promise<string>
}

const defaultRunner =
  (binary: string): ((args: readonly string[]) => Promise<string>) =>
  (args) =>
    new Promise((resolve, reject) => {
      // `codex login status` (unlike `--version`) writes its human-readable
      // status line to stderr, not stdout, so both streams are checked.
      execFile(binary, args as string[], { shell: false }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve((stdout || stderr).trim())
      })
    })

function composePrompt(goal: AgentGoal): string {
  const parts = [goal.role ? `[role: ${goal.role}]\n${goal.goal}` : goal.goal]
  if (goal.context) parts.push('', '## Context', goal.context)
  return parts.join('\n')
}

export class CodexAgentProvider implements AgentProvider {
  readonly info: ProviderInfo = {
    id: 'codex',
    displayName: 'Codex',
    kind: 'agent',
    consumption: 'subscription',
    authentication: ['api-key', 'cli-session'],
  }

  private readonly auth: CodexAuth
  private readonly binary: string
  private readonly sandboxMode: CodexSandboxMode
  private readonly extraArgs: readonly string[]
  private readonly spawner: Spawner
  private readonly runner: (args: readonly string[]) => Promise<string>

  constructor(options: CodexAgentProviderOptions) {
    this.auth = options.auth
    this.binary = options.binary ?? 'codex'
    this.sandboxMode = options.sandboxMode ?? 'workspace-write'
    this.extraArgs = options.extraArgs ?? []
    this.spawner = options.spawner ?? defaultSpawner
    this.runner = options.runner ?? defaultRunner(this.binary)
  }

  capabilities(): CapabilitySet {
    return CapabilitySet.of(
      Capability.Chat,
      Capability.ToolUse,
      Capability.Streaming,
      Capability.CodeExecution,
      Capability.ResumeSession,
    )
  }

  async detect(): Promise<ProviderAvailability> {
    let version: string
    try {
      version = await this.runner(['--version'])
    } catch (error) {
      return {
        installed: false,
        authenticated: false,
        available: false,
        authenticationKind: this.auth.kind,
        detail: error instanceof Error ? error.message : String(error),
      }
    }

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

    try {
      const status = await this.runner(['login', 'status'])
      const authenticated = /logged in/i.test(status)
      return {
        installed: true,
        authenticated,
        available: authenticated,
        authenticationKind: 'cli-session',
        detail: status,
      }
    } catch (error) {
      // `login status` is best-effort: some CLI versions may not support it
      // cheaply. Report installed-only rather than failing detect().
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'cli-session',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    return this.run(request, undefined)
  }

  async resume(providerSessionId: string, request: AgentRunRequest): Promise<AgentRunHandle> {
    return this.run(request, providerSessionId)
  }

  private async run(
    request: AgentRunRequest,
    resumeThreadId: string | undefined,
  ): Promise<AgentRunHandle> {
    const env = await this.resolveEnv()
    const args = this.buildArgs(request, resumeThreadId)
    const startedAt = Date.now()

    const child = this.spawner(this.binary, args, {
      ...(request.workspace?.path !== undefined ? { cwd: request.workspace.path } : {}),
      env,
    })

    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ type: 'agent.started', sessionId: request.sessionId })

    let cancelRequested = false
    let timedOut = false
    let threadId: string | undefined
    let turn = 0
    let lastAgentMessage: string | undefined
    let lastUsage: CodexUsage | undefined
    let turnsCompleted = 0
    let turnFailedMessage: string | undefined
    let lastErrorMessage: string | undefined
    let stderrTail = ''

    let settle: (result: AgentResult) => void = () => {}
    const resultPromise = new Promise<AgentResult>((resolve) => {
      settle = resolve
    })

    const stdoutSplitter = new JsonlSplitter()

    const handleEvent = (event: CodexEvent) => {
      if (event.type === 'thread.started' && 'thread_id' in event) {
        threadId = String(event.thread_id)
        return
      }
      if (event.type === 'turn.started') {
        turn += 1
        queue.push({ type: 'agent.turn.started', turn })
        return
      }
      if (event.type === 'turn.completed' && 'usage' in event) {
        lastUsage = event.usage as CodexUsage
        turnsCompleted += 1
        const model = request.model ?? 'unknown'
        queue.push({
          type: 'agent.usage',
          usage: toUsageRecord(lastUsage, model, Date.now() - startedAt, turnsCompleted).tokens,
          model,
        })
        return
      }
      if (event.type === 'turn.failed' && 'error' in event) {
        turnFailedMessage = (event.error as { message: string }).message
        return
      }
      if (event.type === 'error' && 'message' in event) {
        lastErrorMessage = String(event.message)
        return
      }
      if (event.type === 'item.started' || event.type === 'item.completed') {
        const item = (event as { item?: unknown }).item as CodexItem | undefined
        if (!item) return
        const phase = event.type === 'item.started' ? 'started' : 'completed'
        if (isAgentMessageItem(item) && phase === 'completed') lastAgentMessage = item.text
        for (const agentEvent of fromItemEvent(phase, item)) queue.push(agentEvent)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of stdoutSplitter.push(chunk.toString('utf8'))) {
        if (isCodexEvent(line)) handleEvent(line)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
    })

    const finish = (code: number | null) => {
      for (const line of stdoutSplitter.flush()) {
        if (isCodexEvent(line)) handleEvent(line)
      }

      const model = request.model ?? 'unknown'
      const usage = lastUsage
        ? toUsageRecord(lastUsage, model, Date.now() - startedAt, turnsCompleted)
        : {
            provider: 'codex',
            model,
            tokens: { inputTokens: 0, outputTokens: 0 },
            durationMs: Date.now() - startedAt,
            turns: turn,
            subagents: 0,
          }

      let result: AgentResult
      if (cancelRequested) {
        result = {
          outcome: 'CANCELLED',
          summary: 'Codex run was cancelled',
          usage,
          ...(threadId !== undefined ? { providerSessionId: threadId } : {}),
        }
      } else if (timedOut) {
        result = {
          outcome: 'BUDGET_EXHAUSTED',
          summary: 'Codex run exceeded its wall-clock timeout',
          usage,
          ...(threadId !== undefined ? { providerSessionId: threadId } : {}),
        }
      } else if (turnFailedMessage !== undefined) {
        result = {
          outcome: 'FATAL_FAILURE',
          summary: turnFailedMessage,
          usage,
          ...(threadId !== undefined ? { providerSessionId: threadId } : {}),
        }
      } else if (code === 0) {
        result = {
          outcome: 'GOAL_COMPLETED',
          summary: lastAgentMessage ?? 'Codex run completed',
          usage,
          ...(threadId !== undefined ? { providerSessionId: threadId } : {}),
        }
      } else {
        result = {
          outcome: 'FATAL_FAILURE',
          summary: lastErrorMessage ?? (stderrTail.trim() || `codex exited with code ${code}`),
          usage,
          ...(threadId !== undefined ? { providerSessionId: threadId } : {}),
        }
      }

      queue.push({ type: 'agent.completed', result })
      queue.close()
      settle(result)
    }

    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      const model = request.model ?? 'unknown'
      const result: AgentResult = {
        outcome: 'FATAL_FAILURE',
        summary: `failed to start codex: ${error.message}`,
        usage: {
          provider: 'codex',
          model,
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

  private buildArgs(request: AgentRunRequest, resumeThreadId: string | undefined): string[] {
    const prompt = composePrompt(request.goal)
    const args: string[] = resumeThreadId
      ? ['exec', 'resume', resumeThreadId, '--json']
      : ['exec', '--json']

    if (!resumeThreadId) {
      // cwd and sandbox policy are fixed at session creation; `codex exec
      // resume` does not accept them (they carry over from the original
      // session) and rejects them as unknown flags.
      if (request.workspace?.path !== undefined) args.push('-C', request.workspace.path)
      args.push('--sandbox', this.sandboxMode)
      // Overture owns workspace isolation; without this, codex refuses to
      // run in non-git directories (e.g. temp-directory sandboxes).
      args.push('--skip-git-repo-check')
    }
    if (request.model !== undefined) args.push('-m', request.model)
    args.push(...this.extraArgs)
    args.push(prompt)
    return args
  }

  private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.auth.kind === 'api-key') {
      const key = await this.auth.apiKey()
      if (!key) throw new OrchestratorError('OpenAI API key not configured', 'auth-expired')
      return { ...process.env, OPENAI_API_KEY: key }
    }
    // cli-session: strip any ambient OPENAI_API_KEY so it can never silently
    // override the CLI's stored ChatGPT login.
    const env = { ...process.env }
    delete env.OPENAI_API_KEY
    return env
  }
}
