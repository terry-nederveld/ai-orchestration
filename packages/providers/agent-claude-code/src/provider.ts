/**
 * ClaudeCodeAgentProvider: AgentProvider backed by the Claude Agent SDK,
 * which drives the Claude Code agent loop in-process (spawning the `claude`
 * CLI as its worker process under the hood).
 */

import { execFile } from 'node:child_process'
import type {
  Options as SdkOptions,
  PermissionMode as SdkPermissionMode,
  Query as SdkQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk'
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
  fromAssistantMessage,
  fromUserMessage,
  resultSummary,
  ToolNameTracker,
  toAgentOutcome,
  toUsageRecord,
} from './mapping.js'

export type ClaudeCodeAuth =
  | { readonly kind: 'api-key'; readonly apiKey: () => Promise<string | undefined> }
  | { readonly kind: 'cli-session' }

export interface ClaudeCodeAgentProviderOptions {
  readonly auth: ClaudeCodeAuth
  readonly model?: string
  /**
   * Default 'acceptEdits': auto-accepts file edits but still prompts for
   * other dangerous operations. Autonomous/unattended runs typically need
   * 'bypassPermissions' instead — set it explicitly when the workspace
   * sandboxing already bounds what the agent can do, since it skips every
   * permission check.
   */
  readonly permissionMode?: SdkPermissionMode
  /** Path to the `claude` CLI executable, when not on PATH. */
  readonly executable?: string
  /** Injectable for tests; defaults to the real SDK `query` function. */
  readonly queryImpl?: typeof realQuery
  /** Injectable for tests; defaults to `execFile`-based `claude --version`. */
  readonly versionRunner?: (binary: string) => Promise<string>
}

const defaultVersionRunner = (binary: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { shell: false }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })

function composePrompt(goal: AgentGoal): string {
  const parts = [goal.role ? `[role: ${goal.role}]\n${goal.goal}` : goal.goal]
  if (goal.context) parts.push('', '## Context', goal.context)
  return parts.join('\n')
}

export class ClaudeCodeAgentProvider implements AgentProvider {
  readonly info: ProviderInfo = {
    id: 'claude-code',
    displayName: 'Claude Code',
    kind: 'agent',
    consumption: 'subscription',
    authentication: ['api-key', 'cli-session'],
  }

  private readonly auth: ClaudeCodeAuth
  private readonly model: string | undefined
  private readonly permissionMode: SdkPermissionMode
  private readonly executable: string | undefined
  private readonly queryImpl: typeof realQuery
  private readonly versionRunner: (binary: string) => Promise<string>

  constructor(options: ClaudeCodeAgentProviderOptions) {
    this.auth = options.auth
    this.model = options.model
    this.permissionMode = options.permissionMode ?? 'acceptEdits'
    this.executable = options.executable
    this.queryImpl = options.queryImpl ?? realQuery
    this.versionRunner = options.versionRunner ?? defaultVersionRunner
  }

  capabilities(): CapabilitySet {
    return CapabilitySet.of(
      Capability.Chat,
      Capability.ToolUse,
      Capability.ParallelToolUse,
      Capability.Streaming,
      Capability.Mcp,
      Capability.Skills,
      Capability.Hooks,
      Capability.Subagents,
      Capability.ResumeSession,
      Capability.ContextCompaction,
      Capability.CodeExecution,
    )
  }

  async detect(): Promise<ProviderAvailability> {
    if (this.auth.kind === 'api-key') {
      const key = await this.auth.apiKey()
      return {
        installed: key !== undefined,
        authenticated: key !== undefined,
        available: key !== undefined,
        authenticationKind: 'api-key',
        ...(key === undefined ? { detail: 'no Anthropic API key configured' } : {}),
      }
    }

    try {
      const version = await this.versionRunner(this.executable ?? 'claude')
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
        authenticationKind: 'cli-session',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    return this.run(request, {})
  }

  async resume(providerSessionId: string, request: AgentRunRequest): Promise<AgentRunHandle> {
    return this.run(request, { resume: providerSessionId })
  }

  private async run(
    request: AgentRunRequest,
    extra: { readonly resume?: string },
  ): Promise<AgentRunHandle> {
    const env = await this.resolveEnv()
    const abortController = new AbortController()
    const model = request.model ?? this.model

    const options: SdkOptions = {
      abortController,
      env,
      permissionMode: this.permissionMode,
      ...(this.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(request.workspace?.path !== undefined ? { cwd: request.workspace.path } : {}),
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(request.toolNames !== undefined ? { allowedTools: [...request.toolNames] } : {}),
      ...(request.limits?.maxEstimatedCostUsd !== undefined
        ? { maxBudgetUsd: request.limits.maxEstimatedCostUsd }
        : {}),
      ...(request.systemPrompt !== undefined
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: request.systemPrompt } }
        : {}),
      ...(this.executable !== undefined ? { pathToClaudeCodeExecutable: this.executable } : {}),
      ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
    }

    const prompt = composePrompt(request.goal)
    const sdkQuery = this.queryImpl({ prompt, options })

    const queue = new AsyncQueue<AgentEvent>()
    let cancelRequested = false
    let timedOut = false
    let settle: (result: AgentResult) => void = () => {}
    let fail: (error: unknown) => void = () => {}
    const resultPromise = new Promise<AgentResult>((resolve, reject) => {
      settle = resolve
      fail = reject
    })

    queue.push({ type: 'agent.started', sessionId: request.sessionId })

    const timer =
      request.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            abortController.abort(new Error('agent run timed out'))
            sdkQuery.close()
          }, request.timeoutMs)
        : undefined

    void this.pump(
      sdkQuery,
      queue,
      model,
      { cancelRequested: () => cancelRequested, timedOut: () => timedOut },
      settle,
      fail,
    ).finally(() => {
      if (timer) clearTimeout(timer)
    })

    return {
      sessionId: request.sessionId,
      events: () => queue,
      result: () => resultPromise,
      cancel: async (reason?: string) => {
        cancelRequested = true
        abortController.abort(reason ? new Error(reason) : undefined)
        sdkQuery.close()
      },
    }
  }

  private async pump(
    sdkQuery: SdkQuery,
    queue: AsyncQueue<AgentEvent>,
    fallbackModel: string | undefined,
    flags: { readonly cancelRequested: () => boolean; readonly timedOut: () => boolean },
    settle: (result: AgentResult) => void,
    fail: (error: unknown) => void,
  ): Promise<void> {
    const tools = new ToolNameTracker()
    let turn = 0
    const model = fallbackModel ?? 'unknown'

    const abortedResult = (): AgentResult => ({
      outcome: flags.timedOut() ? 'BUDGET_EXHAUSTED' : 'CANCELLED',
      summary: flags.timedOut()
        ? 'Claude Code run exceeded its wall-clock timeout'
        : 'Claude Code run was cancelled',
      usage: {
        provider: 'claude-code',
        tokens: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
        turns: turn,
        subagents: 0,
      },
    })
    const finish = (result: AgentResult) => {
      queue.push({ type: 'agent.completed', result })
      queue.close()
      settle(result)
    }

    try {
      for await (const message of sdkQuery) {
        if (message.type === 'assistant') {
          turn += 1
          queue.push({ type: 'agent.turn.started', turn })
          for (const event of fromAssistantMessage(message, tools)) queue.push(event)
        } else if (message.type === 'user') {
          for (const event of fromUserMessage(message, tools)) queue.push(event)
        } else if (message.type === 'result') {
          const usage = toUsageRecord(message, model)
          queue.push({ type: 'agent.usage', usage: usage.tokens, model })
          finish({
            outcome: toAgentOutcome(message),
            summary: resultSummary(message),
            usage,
            providerSessionId: message.session_id,
          })
          return
        }
      }
      // The generator ended without a result message (e.g. close() during cancel/timeout).
      finish(abortedResult())
    } catch (error) {
      if (flags.cancelRequested() || flags.timedOut()) {
        finish(abortedResult())
        return
      }
      queue.close()
      fail(
        error instanceof OrchestratorError
          ? error
          : new OrchestratorError(
              error instanceof Error ? error.message : String(error),
              'internal',
              {
                cause: error,
              },
            ),
      )
    }
  }

  private async resolveEnv(): Promise<Record<string, string | undefined>> {
    if (this.auth.kind === 'api-key') {
      const key = await this.auth.apiKey()
      if (!key) throw new OrchestratorError('Anthropic API key not configured', 'auth-expired')
      return { ...process.env, ANTHROPIC_API_KEY: key }
    }
    // cli-session: strip any ambient ANTHROPIC_API_KEY so it can never
    // silently override the CLI's stored subscription credentials.
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    return env
  }
}
