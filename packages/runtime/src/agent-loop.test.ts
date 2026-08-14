import {
  type AgentEvent,
  type AgentRunRequest,
  asId,
  type PermissionCapability,
  type PolicyEngine,
  type SessionRepository,
  type SessionSnapshot,
  type Tool,
} from '@overture/core'
import { ScriptedModelProvider, type ScriptedTurn } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { NativeAgentRuntime, type NativeAgentRuntimeOptions } from './agent-loop.js'
import { DefaultToolRegistry, StaticToolProvider } from './registry.js'

const allowAll: PolicyEngine = { evaluate: () => ({ effect: 'allow' }) }

const echoTool: Tool = {
  descriptor: {
    name: 'echo',
    description: 'echoes input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  requiredPermissions: ['process.execute' as PermissionCapability],
  execute: async (input) => ({ content: `echo: ${(input as { text?: string }).text ?? ''}` }),
}

function makeRuntime(
  script: readonly ScriptedTurn[],
  overrides: Partial<NativeAgentRuntimeOptions> = {},
): { runtime: NativeAgentRuntime; provider: ScriptedModelProvider } {
  const provider = new ScriptedModelProvider(script)
  const tools = new DefaultToolRegistry()
  tools.register(new StaticToolProvider('test', [echoTool]))
  const runtime = new NativeAgentRuntime({
    model: provider,
    defaultModel: 'scripted-1',
    tools,
    policy: allowAll,
    retry: { baseDelayMs: 1 },
    ...overrides,
  })
  return { runtime, provider }
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: asId('run-1'),
    sessionId: asId('session-1'),
    goal: { goal: 'do the thing' },
    ...overrides,
  }
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

describe('NativeAgentRuntime', () => {
  it('completes when the model calls complete_goal', async () => {
    const { runtime } = makeRuntime([
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'all done' },
      },
    ])
    const handle = await runtime.start(request())
    const result = await handle.result()
    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.summary).toBe('all done')
    expect(result.usage.turns).toBe(1)
  })

  it('reports GOAL_BLOCKED when the model declares blocked', async () => {
    const { runtime } = makeRuntime([
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'blocked', summary: 'cannot proceed' },
      },
    ])
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('GOAL_BLOCKED')
    expect(result.summary).toBe('cannot proceed')
  })

  it('executes tools and feeds results back to the model', async () => {
    const { runtime, provider } = makeRuntime([
      { kind: 'tool_call', name: 'echo', input: { text: 'hello' } },
      { kind: 'tool_call', name: 'complete_goal', input: { outcome: 'completed', summary: 'ok' } },
    ])
    const handle = await runtime.start(request())
    const events = await collectEvents(handle.events())
    const result = await handle.result()

    expect(result.outcome).toBe('GOAL_COMPLETED')
    const toolCompleted = events.find((event) => event.type === 'agent.tool.completed')
    expect(toolCompleted && 'content' in toolCompleted && toolCompleted.content).toContain(
      'echo: hello',
    )
    const secondRequest = provider.requests[1]
    expect(secondRequest).toBeDefined()
    const toolMessage = secondRequest?.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(toolMessage?.content[0]).toMatchObject({ type: 'tool_result' })
  })

  it('nudges once on text-only turns, then blocks', async () => {
    const { runtime, provider } = makeRuntime([
      { kind: 'text', text: 'thinking out loud' },
      { kind: 'text', text: 'still just talking' },
    ])
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('GOAL_BLOCKED')
    expect(result.summary).toContain('still just talking')
    const nudge = provider.requests[1]?.messages.at(-1)
    expect(nudge?.role).toBe('user')
    expect(JSON.stringify(nudge?.content)).toContain('complete_goal')
  })

  it('stops at the turn limit with BUDGET_EXHAUSTED', async () => {
    const script: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      kind: 'tool_call' as const,
      name: 'echo',
      input: { text: 'again' },
    }))
    const { runtime } = makeRuntime(script)
    const result = await (await runtime.start(request({ maxTurns: 3 }))).result()
    expect(result.outcome).toBe('BUDGET_EXHAUSTED')
    expect(result.summary).toContain('turn limit')
    expect(result.usage.turns).toBe(3)
  })

  it('enforces token budgets', async () => {
    const { runtime } = makeRuntime([
      {
        kind: 'tool_call',
        name: 'echo',
        input: {},
        usage: { inputTokens: 900, outputTokens: 200 },
      },
      { kind: 'tool_call', name: 'complete_goal', input: { outcome: 'completed', summary: 'x' } },
    ])
    const result = await (await runtime.start(request({ limits: { maxTokens: 1000 } }))).result()
    expect(result.outcome).toBe('BUDGET_EXHAUSTED')
    expect(result.summary).toContain('maxTokens')
  })

  it('returns POLICY_BLOCKED after repeated policy denials', async () => {
    const denyExec: PolicyEngine = {
      evaluate: (permissionRequest) =>
        permissionRequest.capability === 'process.execute'
          ? { effect: 'deny', reason: 'not allowed' }
          : { effect: 'allow' },
    }
    const script: ScriptedTurn[] = Array.from({ length: 5 }, () => ({
      kind: 'tool_call' as const,
      name: 'echo',
      input: { text: 'x' },
    }))
    const { runtime } = makeRuntime(script, { policy: denyExec, maxPolicyDenials: 2 })
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('POLICY_BLOCKED')
  })

  it('asks the approval gateway for ask decisions', async () => {
    const askPolicy: PolicyEngine = { evaluate: () => ({ effect: 'ask' }) }
    const approvals = { requestApproval: async () => true }
    const { runtime } = makeRuntime(
      [
        { kind: 'tool_call', name: 'echo', input: { text: 'approved run' } },
        {
          kind: 'tool_call',
          name: 'complete_goal',
          input: { outcome: 'completed', summary: 'ok' },
        },
      ],
      { policy: askPolicy, approvals },
    )
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('GOAL_COMPLETED')
  })

  it('pauses for human input', async () => {
    const { runtime } = makeRuntime([
      { kind: 'tool_call', name: 'request_human_input', input: { reason: 'need credentials' } },
    ])
    const handle = await runtime.start(request())
    const events = await collectEvents(handle.events())
    const result = await handle.result()
    expect(result.outcome).toBe('HUMAN_INPUT_REQUIRED')
    expect(result.summary).toBe('need credentials')
    expect(events.some((event) => event.type === 'agent.waiting.human')).toBe(true)
  })

  it('cancels cleanly', async () => {
    const { runtime } = makeRuntime([{ kind: 'timeout', afterMs: 5_000 }])
    const handle = await runtime.start(request())
    setTimeout(() => void handle.cancel('user cancelled'), 50)
    const result = await handle.result()
    expect(result.outcome).toBe('CANCELLED')
  })

  it('treats wall-clock timeout as budget exhaustion', async () => {
    const { runtime } = makeRuntime([{ kind: 'timeout', afterMs: 5_000 }])
    const result = await (await runtime.start(request({ timeoutMs: 100 }))).result()
    expect(result.outcome).toBe('BUDGET_EXHAUSTED')
    expect(result.summary).toContain('timeout')
  })

  it('retries retryable model failures', async () => {
    const { runtime } = makeRuntime([
      { kind: 'fail', error: 'connection reset', category: 'network' },
      { kind: 'tool_call', name: 'complete_goal', input: { outcome: 'completed', summary: 'ok' } },
    ])
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('GOAL_COMPLETED')
  })

  it('fails fast on non-retryable model errors', async () => {
    const { runtime } = makeRuntime([
      { kind: 'fail', error: 'bad request', category: 'invalid-input' },
    ])
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('bad request')
  })

  it('runs sub-agents and folds their usage into the parent', async () => {
    const { runtime } = makeRuntime([
      { kind: 'tool_call', name: 'run_subagent', input: { goal: 'child goal' } },
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'child done' },
        usage: { inputTokens: 7, outputTokens: 3 },
      },
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'parent done' },
      },
    ])
    const handle = await runtime.start(request())
    const events = await collectEvents(handle.events())
    const result = await handle.result()

    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.usage.subagents).toBe(1)
    expect(events.some((event) => event.type === 'agent.subagent.started')).toBe(true)
    expect(events.find((event) => event.type === 'agent.subagent.completed')).toMatchObject({
      outcome: 'GOAL_COMPLETED',
    })
    expect(result.usage.tokens.inputTokens).toBeGreaterThanOrEqual(27)
  })

  it('denies sub-agents beyond the per-run limit', async () => {
    const { runtime } = makeRuntime(
      [
        { kind: 'tool_call', name: 'run_subagent', input: { goal: 'child' } },
        { kind: 'tool_call', name: 'complete_goal', input: { outcome: 'completed', summary: 'p' } },
      ],
      { subagents: { enabled: true, maxDepth: 1, maxPerRun: 0 } },
    )
    const result = await (await runtime.start(request())).result()
    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.usage.subagents).toBe(0)
  })

  it('persists sessions and resumes from a snapshot', async () => {
    const snapshots = new Map<string, SessionSnapshot>()
    const sessions: SessionRepository = {
      save: async (snapshot) => {
        snapshots.set(String(snapshot.sessionId), snapshot)
      },
      get: async (id) => snapshots.get(String(id)),
      listForRun: async () => [...snapshots.values()],
    }
    const first = makeRuntime(
      [
        { kind: 'tool_call', name: 'echo', input: { text: 'step one' } },
        { kind: 'tool_call', name: 'request_human_input', input: { reason: 'pause' } },
      ],
      { sessions },
    )
    const firstResult = await (await first.runtime.start(request())).result()
    expect(firstResult.outcome).toBe('HUMAN_INPUT_REQUIRED')
    expect(snapshots.size).toBe(1)

    const second = makeRuntime(
      [
        {
          kind: 'tool_call',
          name: 'complete_goal',
          input: { outcome: 'completed', summary: 'resumed' },
        },
      ],
      { sessions },
    )
    const handle = await second.runtime.resume('session-1', request())
    const result = await handle.result()
    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.summary).toBe('resumed')
    const resumedFirstRequest = second.provider.requests[0]
    expect(JSON.stringify(resumedFirstRequest?.messages)).toContain('step one')
  })

  it('emits streamed text deltas as agent.text events', async () => {
    const { runtime } = makeRuntime([
      { kind: 'text', text: 'a longer streamed sentence' },
      { kind: 'tool_call', name: 'complete_goal', input: { outcome: 'completed', summary: 'ok' } },
    ])
    const handle = await runtime.start(request())
    const events = await collectEvents(handle.events())
    const textEvents = events.filter((event) => event.type === 'agent.text')
    expect(textEvents.length).toBeGreaterThan(1)
    expect(textEvents.map((event) => ('text' in event ? event.text : '')).join('')).toBe(
      'a longer streamed sentence',
    )
  })
})
