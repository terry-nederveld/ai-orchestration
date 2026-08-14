import { asId } from '@overture/core'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeAgentProvider } from './provider.js'
import {
  assistantMessage,
  type FakeQueryCall,
  fakeQuery,
  hangingQuery,
  resultError,
  resultSuccess,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userMessage,
} from './test-helpers.js'

const runId = asId('run-1')
const sessionId = asId('session-1')

function baseRequest(overrides: Partial<Parameters<ClaudeCodeAgentProvider['start']>[0]> = {}) {
  return {
    runId,
    sessionId,
    goal: { goal: 'fix the bug' },
    ...overrides,
  } as Parameters<ClaudeCodeAgentProvider['start']>[0]
}

async function drain(handle: { events(): AsyncIterable<unknown> }): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of handle.events()) events.push(event)
  return events
}

describe('ClaudeCodeAgentProvider.start', () => {
  it('translates a successful run into GOAL_COMPLETED with usage and providerSessionId', async () => {
    const calls: FakeQueryCall[] = []
    const messages = [
      assistantMessage([textBlock('working on it'), toolUseBlock('t1', 'Read', { path: 'a.txt' })]),
      userMessage([toolResultBlock('t1', 'contents')]),
      resultSuccess({ session_id: 'sdk-session-42', result: 'fixed it' }),
    ]
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: fakeQuery(messages, calls),
    })

    const handle = await provider.start(baseRequest())
    const events = await drain(handle)
    const result = await handle.result()

    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.summary).toBe('fixed it')
    expect(result.providerSessionId).toBe('sdk-session-42')
    expect(result.usage.provider).toBe('claude-code')

    expect(events[0]).toEqual({ type: 'agent.started', sessionId })
    expect(events.some((e) => (e as { type: string }).type === 'agent.tool.started')).toBe(true)
    expect(events.some((e) => (e as { type: string }).type === 'agent.tool.completed')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'agent.completed', result })
  })

  it('maps error_max_turns to BUDGET_EXHAUSTED', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: fakeQuery([resultError('error_max_turns')]),
    })
    const handle = await provider.start(baseRequest())
    const result = await handle.result()
    expect(result.outcome).toBe('BUDGET_EXHAUSTED')
  })

  it('maps error_during_execution to FATAL_FAILURE', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: fakeQuery([resultError('error_during_execution')]),
    })
    const handle = await provider.start(baseRequest())
    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
  })

  it('cancel() ends the run with CANCELLED', async () => {
    const hanging = hangingQuery()
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: hanging.impl,
    })
    const handle = await provider.start(baseRequest())
    await handle.cancel('user requested stop')
    const result = await handle.result()
    expect(result.outcome).toBe('CANCELLED')
  })

  it('kills the run with BUDGET_EXHAUSTED when timeoutMs elapses', async () => {
    vi.useFakeTimers()
    try {
      const hanging = hangingQuery()
      const provider = new ClaudeCodeAgentProvider({
        auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
        queryImpl: hanging.impl,
      })
      const handle = await provider.start(baseRequest({ timeoutMs: 50 }))
      const resultPromise = handle.result()
      await vi.advanceTimersByTimeAsync(60)
      const result = await resultPromise
      expect(result.outcome).toBe('BUDGET_EXHAUSTED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets ANTHROPIC_API_KEY in the child env for api-key auth', async () => {
    const calls: FakeQueryCall[] = []
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-live-123' },
      queryImpl: fakeQuery([resultSuccess()], calls),
    })
    await provider.start(baseRequest())
    expect(calls[0]?.options?.env?.ANTHROPIC_API_KEY).toBe('sk-live-123')
  })

  it('strips ANTHROPIC_API_KEY from the child env for cli-session auth', async () => {
    const calls: FakeQueryCall[] = []
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'should-not-leak'
    try {
      const provider = new ClaudeCodeAgentProvider({
        auth: { kind: 'cli-session' },
        queryImpl: fakeQuery([resultSuccess()], calls),
      })
      await provider.start(baseRequest())
      expect(calls[0]?.options?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('throws when api-key auth resolves no key', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => undefined },
      queryImpl: fakeQuery([resultSuccess()]),
    })
    await expect(provider.start(baseRequest())).rejects.toThrow(/API key/)
  })

  it('defaults permissionMode to acceptEdits', async () => {
    const calls: FakeQueryCall[] = []
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: fakeQuery([resultSuccess()], calls),
    })
    await provider.start(baseRequest())
    expect(calls[0]?.options?.permissionMode).toBe('acceptEdits')
    expect(calls[0]?.options?.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('sets allowDangerouslySkipPermissions when permissionMode is bypassPermissions', async () => {
    const calls: FakeQueryCall[] = []
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      permissionMode: 'bypassPermissions',
      queryImpl: fakeQuery([resultSuccess()], calls),
    })
    await provider.start(baseRequest())
    expect(calls[0]?.options?.permissionMode).toBe('bypassPermissions')
    expect(calls[0]?.options?.allowDangerouslySkipPermissions).toBe(true)
  })
})

describe('ClaudeCodeAgentProvider.resume', () => {
  it('passes providerSessionId as options.resume', async () => {
    const calls: FakeQueryCall[] = []
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
      queryImpl: fakeQuery([resultSuccess()], calls),
    })
    await provider.resume('sdk-session-old', baseRequest())
    expect(calls[0]?.options?.resume).toBe('sdk-session-old')
  })
})

describe('ClaudeCodeAgentProvider.detect', () => {
  it('reports available when an api key is configured', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-test' },
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: true, available: true })
  })

  it('reports unavailable when no api key is configured', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => undefined },
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: false, authenticated: false, available: false })
  })

  it('reports available for cli-session when the claude CLI resolves a version', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'cli-session' },
      versionRunner: async () => '2.1.232 (Claude Code)',
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: true, available: true })
  })

  it('reports unavailable for cli-session when the claude CLI is missing', async () => {
    const provider = new ClaudeCodeAgentProvider({
      auth: { kind: 'cli-session' },
      versionRunner: async () => {
        throw new Error('ENOENT')
      },
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: false, authenticated: false, available: false })
  })
})
