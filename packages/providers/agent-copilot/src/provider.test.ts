import { asId } from '@overture/core'
import { describe, expect, it, vi } from 'vitest'
import { CopilotAgentProvider } from './provider.js'
import { fakeSpawner } from './test-helpers.js'

const runId = asId('run-1')
const sessionId = asId('session-1')

function baseRequest(overrides: Partial<Parameters<CopilotAgentProvider['start']>[0]> = {}) {
  return { runId, sessionId, goal: { goal: 'fix the bug' }, ...overrides } as Parameters<
    CopilotAgentProvider['start']
  >[0]
}

async function drain(handle: { events(): AsyncIterable<unknown> }): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of handle.events()) events.push(event)
  return events
}

describe('CopilotAgentProvider.start', () => {
  it('streams stdout as agent.text and resolves GOAL_COMPLETED on a clean exit', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())
    const eventsPromise = drain(handle)

    child.emitStdout('working on it...\n')
    child.emitStdout('fixed the bug.\n')
    child.emitClose(0)

    const result = await handle.result()
    const events = await eventsPromise

    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.summary).toBe('working on it...\nfixed the bug.')
    expect(events[0]).toEqual({ type: 'agent.started', sessionId })
    expect(events.filter((e) => (e as { type: string }).type === 'agent.text')).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: 'agent.completed', result })
  })

  it('maps a non-zero exit to FATAL_FAILURE using stderr, falling back to stdout tail', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitStdout('partial progress\n')
    child.emitStderr('copilot: permission denied\n')
    child.emitClose(1)

    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('permission denied')
  })

  it('falls back to the exit code when there is no stdout or stderr', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitClose(2)

    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('2')
  })

  it('cancel() kills the process and resolves CANCELLED', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    await handle.cancel('stop')
    expect(child.killedWith).toContain('SIGKILL')
    child.emitClose(null)

    const result = await handle.result()
    expect(result.outcome).toBe('CANCELLED')
  })

  it('kills the process and resolves BUDGET_EXHAUSTED when timeoutMs elapses', async () => {
    vi.useFakeTimers()
    try {
      const { spawner, child } = fakeSpawner()
      const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
      const handle = await provider.start(baseRequest({ timeoutMs: 50 }))

      await vi.advanceTimersByTimeAsync(60)
      expect(child.killedWith).toContain('SIGKILL')
      child.emitClose(null)

      const result = await handle.result()
      expect(result.outcome).toBe('BUDGET_EXHAUSTED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports FATAL_FAILURE when the process fails to spawn', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitError(new Error('ENOENT'))
    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('ENOENT')
  })

  it('passes -p, --allow-all-tools, and --no-color', async () => {
    const { spawner, calls, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())
    child.emitClose(0)
    await handle.result()

    const args = calls[0]?.args ?? []
    expect(args[0]).toBe('-p')
    expect(args).toContain('--allow-all-tools')
    expect(args).toContain('--no-color')
  })

  it('sets COPILOT_GITHUB_TOKEN in the child env for api-key auth', async () => {
    const { spawner, calls, child } = fakeSpawner()
    const provider = new CopilotAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'ghu_test' },
      spawner,
    })
    const handle = await provider.start(baseRequest())
    child.emitClose(0)
    await handle.result()
    expect(calls[0]?.options.env.COPILOT_GITHUB_TOKEN).toBe('ghu_test')
  })

  it('throws when api-key auth resolves no token', async () => {
    const { spawner } = fakeSpawner()
    const provider = new CopilotAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => undefined },
      spawner,
    })
    await expect(provider.start(baseRequest())).rejects.toThrow(/Copilot token/)
  })
})

describe('CopilotAgentProvider.detect', () => {
  it('reports installed:false cleanly when the binary is missing (matches this machine, which has no copilot CLI)', async () => {
    const provider = new CopilotAgentProvider({
      auth: { kind: 'cli-session' },
      versionRunner: async () => {
        throw new Error('ENOENT: copilot not found')
      },
    })
    const availability = await provider.detect()
    expect(availability).toEqual({
      installed: false,
      authenticated: false,
      available: false,
      authenticationKind: 'cli-session',
      detail: 'ENOENT: copilot not found',
    })
  })

  it('reports available:true for cli-session when the binary resolves a version', async () => {
    const provider = new CopilotAgentProvider({
      auth: { kind: 'cli-session' },
      versionRunner: async () => '1.2.3',
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: true, available: true })
  })

  it('reports available:true for api-key auth only when a token resolves', async () => {
    const provider = new CopilotAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => undefined },
      versionRunner: async () => '1.2.3',
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: false, available: false })
  })
})
