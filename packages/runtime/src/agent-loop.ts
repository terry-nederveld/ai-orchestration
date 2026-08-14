/**
 * The native agent loop. Deliberately small and observable:
 *
 *   while not done:
 *     compact context if needed
 *     response = model.invoke(context, tools)
 *     if tool calls: check policy, execute, append results
 *     else: nudge toward explicit completion
 *     enforce budgets and limits
 *
 * Completion is explicit (protocol tools); every state change emits an event;
 * all side effects go through injected ports.
 */

import {
  type AgentEvent,
  type AgentOutcome,
  type AgentResult,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentRuntime,
  type ApprovalGateway,
  addTokenUsage,
  asId,
  BudgetTracker,
  type Clock,
  type ContentBlock,
  emptyTokenUsage,
  type HookRegistry,
  type IdGenerator,
  type Logger,
  type Message,
  type ModelProvider,
  type ModelResponse,
  noopLogger,
  type PolicyEngine,
  type SessionId,
  type SessionRepository,
  systemClock,
  type TokenUsage,
  type Tool,
  type ToolRegistry,
  type ToolResultBlock,
  toOrchestratorError,
} from '@overture/core'
import { AsyncQueue } from './async-queue.js'
import {
  type CompactionOptions,
  compactMessages,
  defaultCompactionOptions,
  truncate,
} from './context.js'
import {
  COMPLETE_GOAL_TOOL,
  completeGoalDescriptor,
  parseCompleteGoal,
  parseReason,
  REQUEST_HUMAN_INPUT_TOOL,
  RUN_SUBAGENT_TOOL,
  requestHumanInputDescriptor,
  runSubagentDescriptor,
  runtimeInstructions,
} from './protocol.js'

export interface RetryOptions {
  readonly maxAttempts: number
  readonly baseDelayMs: number
}

export interface SubagentOptions {
  readonly enabled: boolean
  readonly maxDepth: number
  readonly maxPerRun: number
}

export interface NativeAgentRuntimeOptions {
  readonly model: ModelProvider
  readonly defaultModel: string
  readonly tools: ToolRegistry
  readonly policy: PolicyEngine
  readonly approvals?: ApprovalGateway
  readonly hooks?: HookRegistry
  readonly sessions?: SessionRepository
  readonly clock?: Clock
  readonly idGenerator?: IdGenerator
  readonly logger?: Logger
  readonly retry?: Partial<RetryOptions>
  readonly compaction?: Partial<CompactionOptions>
  readonly subagents?: Partial<SubagentOptions>
  readonly defaultMaxTurns?: number
  readonly toolTimeoutMs?: number
  /** Estimates USD cost of a model call for budget enforcement. */
  readonly costEstimator?: (model: string, usage: TokenUsage) => number | undefined
  readonly resolveSecret?: (name: string) => Promise<string | undefined>
  /** Consecutive text-only turns tolerated before declaring no progress. */
  readonly maxTextOnlyTurns?: number
  /** Tool-call policy denials tolerated before POLICY_BLOCKED. */
  readonly maxPolicyDenials?: number
}

interface SessionState {
  readonly queue: AsyncQueue<AgentEvent>
  readonly abort: AbortController
  outcomeOverride?: AgentOutcome
  overrideReason?: string
}

const defaultRetry: RetryOptions = { maxAttempts: 3, baseDelayMs: 500 }
const defaultSubagents: SubagentOptions = { enabled: true, maxDepth: 1, maxPerRun: 4 }

export class NativeAgentRuntime implements AgentRuntime {
  private readonly retryOptions: RetryOptions
  private readonly compactionOptions: CompactionOptions
  private readonly subagentOptions: SubagentOptions
  private readonly clock: Clock
  private readonly logger: Logger

  constructor(private readonly options: NativeAgentRuntimeOptions) {
    this.retryOptions = { ...defaultRetry, ...options.retry }
    this.compactionOptions = { ...defaultCompactionOptions, ...options.compaction }
    this.subagentOptions = { ...defaultSubagents, ...options.subagents }
    this.clock = options.clock ?? systemClock
    this.logger = options.logger ?? noopLogger
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    return this.launch(request, this.initialMessages(request), 0)
  }

  async resume(providerSessionId: string, request: AgentRunRequest): Promise<AgentRunHandle> {
    const sessions = this.options.sessions
    if (!sessions) throw new Error('resume requires a session repository')
    const snapshot = await sessions.get(asId<'session'>(providerSessionId))
    if (!snapshot) throw new Error(`no session snapshot for ${providerSessionId}`)
    return this.launch(request, [...snapshot.messages], 0)
  }

  private launch(request: AgentRunRequest, messages: Message[], depth: number): AgentRunHandle {
    const state: SessionState = {
      queue: new AsyncQueue<AgentEvent>(),
      abort: new AbortController(),
    }
    let resolveResult: (result: AgentResult) => void = () => {}
    const resultPromise = new Promise<AgentResult>((resolve) => {
      resolveResult = resolve
    })

    void this.runLoop(request, messages, depth, state)
      .then((result) => {
        state.queue.push({ type: 'agent.completed', result })
        resolveResult(result)
      })
      .catch((error) => {
        const result: AgentResult = {
          outcome: 'FATAL_FAILURE',
          summary: `runtime failure: ${error instanceof Error ? error.message : String(error)}`,
          usage: {
            provider: this.options.model.info.id,
            tokens: emptyTokenUsage,
            durationMs: 0,
            turns: 0,
            subagents: 0,
          },
        }
        state.queue.push({ type: 'agent.completed', result })
        resolveResult(result)
      })
      .finally(() => state.queue.close())

    return {
      sessionId: request.sessionId,
      events: () => state.queue,
      result: () => resultPromise,
      cancel: async (reason?: string) => {
        state.outcomeOverride = 'CANCELLED'
        state.overrideReason = reason ?? 'cancelled'
        state.abort.abort(new Error(state.overrideReason))
      },
    }
  }

  private initialMessages(request: AgentRunRequest): Message[] {
    const parts = [`Goal:\n${request.goal.goal}`]
    if (request.goal.context) parts.push(`Context:\n${request.goal.context}`)
    return [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }]
  }

  private async runLoop(
    request: AgentRunRequest,
    messages: Message[],
    depth: number,
    state: SessionState,
  ): Promise<AgentResult> {
    const startedAt = this.clock.now().getTime()
    const model = request.model ?? this.options.defaultModel
    const emit = (event: AgentEvent) => state.queue.push(event)
    emit({ type: 'agent.started', sessionId: request.sessionId })

    const budget = new BudgetTracker({
      id: String(request.runId),
      period: 'run',
      limits: request.limits ?? {},
    })
    const maxTurns = request.maxTurns ?? this.options.defaultMaxTurns ?? 50
    const maxTextOnly = this.options.maxTextOnlyTurns ?? 2
    const maxDenials = this.options.maxPolicyDenials ?? 5

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (request.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        state.outcomeOverride = 'BUDGET_EXHAUSTED'
        state.overrideReason = `wall-clock timeout after ${request.timeoutMs}ms`
        state.abort.abort(new Error(state.overrideReason))
      }, request.timeoutMs)
    }

    const tools = await this.resolveTools(request, depth)
    const descriptors = [
      ...tools.map((tool) => tool.descriptor),
      completeGoalDescriptor,
      requestHumanInputDescriptor,
      ...(this.subagentAllowed(depth) ? [runSubagentDescriptor] : []),
    ]
    const system = [request.systemPrompt, runtimeInstructions(request.workspace?.path)]
      .filter(Boolean)
      .join('\n\n')

    let totalUsage: TokenUsage = emptyTokenUsage
    let turn = 0
    let textOnlyTurns = 0
    let policyDenials = 0
    let subagentsUsed = 0
    let lastText = ''

    const finish = (outcome: AgentOutcome, summary: string): AgentResult => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const estimatedCostUsd = this.estimateCost(model, totalUsage)
      return {
        outcome,
        summary,
        usage: {
          provider: this.options.model.info.id,
          model,
          tokens: totalUsage,
          ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
          durationMs: this.clock.now().getTime() - startedAt,
          turns: turn,
          subagents: subagentsUsed,
        },
        providerSessionId: String(request.sessionId),
      }
    }

    const hooks = this.options.hooks

    try {
      while (true) {
        if (state.abort.signal.aborted) {
          return finish(state.outcomeOverride ?? 'CANCELLED', state.overrideReason ?? 'aborted')
        }
        if (turn >= maxTurns) {
          return finish('BUDGET_EXHAUSTED', `turn limit of ${maxTurns} reached`)
        }
        turn += 1
        emit({ type: 'agent.turn.started', turn })

        const response = await this.invokeWithRetry(
          { model, system, messages, tools: descriptors },
          state,
          emit,
        )
        if (response === 'aborted') {
          return finish(state.outcomeOverride ?? 'CANCELLED', state.overrideReason ?? 'aborted')
        }
        if (response instanceof Error) {
          return finish('FATAL_FAILURE', `model invocation failed: ${response.message}`)
        }

        totalUsage = addTokenUsage(totalUsage, response.usage)
        emit({ type: 'agent.usage', usage: response.usage, model: response.model })
        const cost = this.estimateCost(model, response.usage)
        const status = budget.record({
          tokens: response.usage.inputTokens + response.usage.outputTokens,
          iterations: 1,
          wallClockMs: this.clock.now().getTime() - startedAt,
          ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
        })
        if (status.exhausted) {
          return finish(
            'BUDGET_EXHAUSTED',
            `budget exhausted on: ${status.exhaustedDimensions.join(', ')}`,
          )
        }

        const text = collectText(response)
        if (text) lastText = text
        const toolCalls = response.content.filter((block) => block.type === 'tool_call')

        if (toolCalls.length === 0) {
          textOnlyTurns += 1
          if (textOnlyTurns >= maxTextOnly) {
            return finish(
              'GOAL_BLOCKED',
              lastText || 'agent stopped making progress without declaring completion',
            )
          }
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `If the goal is complete, call ${COMPLETE_GOAL_TOOL} with your final report. ` +
                  'Otherwise continue working with tools.',
              },
            ],
          })
          continue
        }
        textOnlyTurns = 0
        messages.push({ role: 'assistant', content: response.content })

        const results: ToolResultBlock[] = []
        for (const call of toolCalls) {
          if (state.abort.signal.aborted) break

          if (call.name === COMPLETE_GOAL_TOOL) {
            const parsed = parseCompleteGoal(call.input)
            await this.persist(request, messages, model, system)
            return finish(
              parsed.outcome === 'completed' ? 'GOAL_COMPLETED' : 'GOAL_BLOCKED',
              parsed.summary || lastText,
            )
          }
          if (call.name === REQUEST_HUMAN_INPUT_TOOL) {
            const reason = parseReason(call.input)
            emit({ type: 'agent.waiting.human', reason })
            await this.persist(request, messages, model, system)
            return finish('HUMAN_INPUT_REQUIRED', reason)
          }
          if (call.name === RUN_SUBAGENT_TOOL) {
            if (
              !this.subagentAllowed(depth) ||
              subagentsUsed >= this.effectiveMaxSubagents(request)
            ) {
              results.push(
                errorResult(call.id, 'sub-agent limit reached; complete the work directly'),
              )
              continue
            }
            subagentsUsed += 1
            const { result, usage } = await this.runSubagent(request, call.input, depth, emit)
            totalUsage = addTokenUsage(totalUsage, usage)
            results.push({
              type: 'tool_result',
              toolCallId: call.id,
              content: `[sub-agent ${result.outcome}] ${result.summary}`,
              isError: result.outcome === 'FATAL_FAILURE',
            })
            continue
          }

          const tool = tools.find((candidate) => candidate.descriptor.name === call.name)
          if (!tool) {
            results.push(errorResult(call.id, `unknown tool: ${call.name}`))
            continue
          }

          emit({
            type: 'agent.tool.started',
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })

          if (hooks) {
            const hookOutcome = await hooks.run({
              point: 'before_tool_call',
              runId: String(request.runId),
              payload: { toolName: call.name, input: call.input },
            })
            if (hookOutcome.action === 'block') {
              const content = `tool call blocked by hook: ${hookOutcome.reason ?? 'no reason given'}`
              results.push(errorResult(call.id, content))
              emit({
                type: 'agent.tool.completed',
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content,
              })
              continue
            }
          }

          const permission = await this.checkPermissions(tool, call.input, request)
          if (!permission.allowed) {
            policyDenials += 1
            results.push(errorResult(call.id, permission.message))
            emit({
              type: 'agent.tool.completed',
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              content: permission.message,
            })
            if (policyDenials >= maxDenials) {
              await this.persist(request, messages, model, system)
              return finish('POLICY_BLOCKED', `policy denied ${policyDenials} tool calls; stopping`)
            }
            continue
          }

          const result = await this.executeTool(tool, call.input, request, state)
          results.push({
            type: 'tool_result',
            toolCallId: call.id,
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
          })
          emit({
            type: 'agent.tool.completed',
            toolCallId: call.id,
            toolName: call.name,
            isError: result.isError ?? false,
            content: truncate(result.content, 2_000),
          })

          if (hooks) {
            await hooks.run({
              point: 'after_tool_call',
              runId: String(request.runId),
              payload: { toolName: call.name, isError: result.isError ?? false },
            })
          }
        }

        messages.push({ role: 'tool', content: results })

        if (hooks) {
          await hooks.run({
            point: 'after_agent_turn',
            runId: String(request.runId),
            payload: { turn },
          })
        }

        await this.persist(request, messages, model, system)

        if (response.usage.inputTokens >= this.compactionOptions.triggerInputTokens) {
          const compacted = await compactMessages(
            this.options.model,
            model,
            messages,
            this.compactionOptions,
            state.abort.signal,
          )
          if (compacted.compacted) {
            messages.length = 0
            messages.push(...compacted.messages)
          }
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private subagentAllowed(depth: number): boolean {
    return this.subagentOptions.enabled && depth < this.subagentOptions.maxDepth
  }

  private effectiveMaxSubagents(request: AgentRunRequest): number {
    return request.limits?.maxSubagentsPerRun ?? this.subagentOptions.maxPerRun
  }

  private estimateCost(model: string, usage: TokenUsage): number | undefined {
    return this.options.costEstimator?.(model, usage)
  }

  private async resolveTools(request: AgentRunRequest, _depth: number): Promise<readonly Tool[]> {
    return this.options.tools.resolve(request.toolNames)
  }

  private async invokeWithRetry(
    request: {
      model: string
      system: string
      messages: readonly Message[]
      tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
    },
    state: SessionState,
    emit: (event: AgentEvent) => void,
  ): Promise<ModelResponse | Error | 'aborted'> {
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt += 1) {
      if (state.abort.signal.aborted) return 'aborted'
      try {
        let response: ModelResponse | undefined
        for await (const event of this.options.model.stream(
          {
            model: request.model,
            system: request.system,
            messages: request.messages,
            tools: request.tools,
          },
          state.abort.signal,
        )) {
          if (event.type === 'text_delta') emit({ type: 'agent.text', text: event.text })
          else if (event.type === 'thinking_delta')
            emit({ type: 'agent.thinking', text: event.text })
          else if (event.type === 'response') response = event.response
        }
        if (!response) throw new Error('model stream ended without response')
        return response
      } catch (error) {
        if (state.abort.signal.aborted) return 'aborted'
        const orchestratorError = toOrchestratorError(error)
        lastError = orchestratorError
        this.logger.warn('model invocation failed', {
          attempt,
          category: orchestratorError.category,
          message: orchestratorError.message,
        })
        if (!orchestratorError.retryable || attempt === this.retryOptions.maxAttempts) {
          return orchestratorError
        }
        const delay =
          orchestratorError.options?.retryAfterMs ??
          this.retryOptions.baseDelayMs * 2 ** (attempt - 1)
        const aborted = await sleepAbortable(delay, state.abort.signal)
        if (aborted) return 'aborted'
      }
    }
    return lastError ?? new Error('model invocation failed')
  }

  private async checkPermissions(
    tool: Tool,
    input: unknown,
    request: AgentRunRequest,
  ): Promise<{ allowed: true } | { allowed: false; message: string }> {
    const target = tool.policyTarget?.(input) ?? targetOf(input)
    for (const capability of tool.requiredPermissions) {
      const permissionRequest = {
        capability,
        ...(target !== undefined ? { target } : {}),
        runId: String(request.runId),
        toolName: tool.descriptor.name,
      }
      const decision = this.options.policy.evaluate(permissionRequest)
      if (decision.effect === 'allow') continue
      if (decision.effect === 'ask' && this.options.approvals) {
        const approved = await this.options.approvals.requestApproval(permissionRequest, decision)
        if (approved) continue
        return { allowed: false, message: `permission denied by user: ${capability}` }
      }
      return {
        allowed: false,
        message: `permission denied (${decision.effect}): ${capability}${
          decision.reason ? ` — ${decision.reason}` : ''
        }`,
      }
    }
    return { allowed: true }
  }

  private async executeTool(
    tool: Tool,
    input: unknown,
    request: AgentRunRequest,
    state: SessionState,
  ): Promise<{ content: string; isError?: boolean }> {
    const timeoutMs = this.options.toolTimeoutMs ?? 120_000
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([state.abort.signal, timeoutSignal])
    try {
      const result = await tool.execute(input, {
        runId: String(request.runId),
        sessionId: String(request.sessionId),
        ...(request.workspace ? { workspace: request.workspace } : {}),
        logger: this.logger.child({ tool: tool.descriptor.name }),
        signal,
        resolveSecret: async (name) => this.options.resolveSecret?.(name),
      })
      return { content: result.content, ...(result.isError ? { isError: true } : {}) }
    } catch (error) {
      const message = timeoutSignal.aborted
        ? `tool timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
      return { content: `tool failed: ${message}`, isError: true }
    }
  }

  private async runSubagent(
    parent: AgentRunRequest,
    input: unknown,
    depth: number,
    emit: (event: AgentEvent) => void,
  ): Promise<{ result: AgentResult; usage: TokenUsage }> {
    const record = (input ?? {}) as Record<string, unknown>
    const goal = typeof record.goal === 'string' ? record.goal : ''
    const context = typeof record.context === 'string' ? record.context : undefined
    const childSessionId: SessionId = asId(
      `${String(parent.sessionId)}.sub${this.clock.now().getTime()}`,
    )
    emit({ type: 'agent.subagent.started', childSessionId })
    const childRequest: AgentRunRequest = {
      ...parent,
      sessionId: childSessionId,
      goal: { goal, ...(context ? { context } : {}) },
      maxTurns: Math.min(parent.maxTurns ?? this.options.defaultMaxTurns ?? 50, 25),
    }
    const handle = this.launch(childRequest, this.initialMessages(childRequest), depth + 1)
    const result = await handle.result()
    emit({ type: 'agent.subagent.completed', childSessionId, outcome: result.outcome })
    return { result, usage: result.usage.tokens }
  }

  private async persist(
    request: AgentRunRequest,
    messages: readonly Message[],
    model: string,
    systemPrompt: string,
  ): Promise<void> {
    const sessions = this.options.sessions
    if (!sessions) return
    try {
      await sessions.save({
        sessionId: request.sessionId,
        runId: request.runId,
        provider: this.options.model.info.id,
        model,
        systemPrompt,
        messages,
        updatedAt: this.clock.now(),
      })
    } catch (error) {
      this.logger.warn('session persistence failed', {
        sessionId: String(request.sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function collectText(response: ModelResponse): string {
  return response.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function errorResult(toolCallId: string, content: string): ToolResultBlock {
  return { type: 'tool_result', toolCallId, content, isError: true }
}

function targetOf(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['path', 'file', 'file_path', 'command', 'url', 'name']) {
      if (typeof record[key] === 'string') return record[key]
    }
  }
  return undefined
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(true)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
