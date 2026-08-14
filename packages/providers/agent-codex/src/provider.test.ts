import { asId } from '@overture/core'
import { describe, expect, it, vi } from 'vitest'
import { CodexAgentProvider } from './provider.js'
import { fakeSpawner, jsonl } from './test-helpers.js'

const runId = asId('run-1')
const sessionId = asId('session-1')

function baseRequest(overrides: Partial<Parameters<CodexAgentProvider['start']>[0]> = {}) {
  return { runId, sessionId, goal: { goal: 'fix the bug' }, ...overrides } as Parameters<
    CodexAgentProvider['start']
  >[0]
}

async function drain(handle: { events(): AsyncIterable<unknown> }): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of handle.events()) events.push(event)
  return events
}

describe('CodexAgentProvider.start', () => {
  it('translates a clean exit into GOAL_COMPLETED using the last agent_message', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })

    const handlePromise = provider.start(baseRequest())
    const handle = await handlePromise
    const eventsPromise = drain(handle)

    child.emitStdout(
      jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'fixed it' } },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        },
      ),
    )
    child.emitClose(0)

    const result = await handle.result()
    const events = await eventsPromise

    expect(result.outcome).toBe('GOAL_COMPLETED')
    expect(result.summary).toBe('fixed it')
    expect(result.providerSessionId).toBe('thread-1')
    expect(result.usage.provider).toBe('codex')
    expect(events[0]).toEqual({ type: 'agent.started', sessionId })
    expect(events.at(-1)).toEqual({ type: 'agent.completed', result })
  })

  it('emits agent.tool.started/completed for command_execution items', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())
    const eventsPromise = drain(handle)

    child.emitStdout(
      jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: 'ls',
            aggregated_output: '',
            exit_code: null,
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: 'ls',
            aggregated_output: 'a.txt\n',
            exit_code: 0,
            status: 'completed',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        },
      ),
    )
    child.emitClose(0)
    await handle.result()
    const events = (await eventsPromise) as Array<{ type: string }>

    expect(events.some((e) => e.type === 'agent.tool.started')).toBe(true)
    expect(events.some((e) => e.type === 'agent.tool.completed')).toBe(true)
  })

  it('maps turn.failed to FATAL_FAILURE using the error message', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitStdout(
      jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'error', message: 'invalid_request_error: bad model' },
        { type: 'turn.failed', error: { message: 'invalid_request_error: bad model' } },
      ),
    )
    child.emitClose(1)

    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toBe('invalid_request_error: bad model')
  })

  it('maps a non-zero exit with no turn.failed to FATAL_FAILURE', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitStderr('codex: unexpected crash')
    child.emitClose(1)

    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('unexpected crash')
  })

  it('cancel() kills the process and resolves CANCELLED', async () => {
    const { spawner, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
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
      const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
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
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.start(baseRequest())

    child.emitError(new Error('ENOENT'))
    const result = await handle.result()
    expect(result.outcome).toBe('FATAL_FAILURE')
    expect(result.summary).toContain('ENOENT')
  })

  it('sets OPENAI_API_KEY in the child env for api-key auth', async () => {
    const { spawner, calls, child } = fakeSpawner()
    const provider = new CodexAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-oai-1' },
      spawner,
    })
    const handle = await provider.start(baseRequest())
    child.emitClose(0)
    await handle.result()
    expect(calls[0]?.options.env.OPENAI_API_KEY).toBe('sk-oai-1')
  })

  it('strips OPENAI_API_KEY from the child env for cli-session auth', async () => {
    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'should-not-leak'
    try {
      const { spawner, calls, child } = fakeSpawner()
      const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
      const handle = await provider.start(baseRequest())
      child.emitClose(0)
      await handle.result()
      expect(calls[0]?.options.env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }
  })

  it('throws when api-key auth resolves no key', async () => {
    const { spawner } = fakeSpawner()
    const provider = new CodexAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => undefined },
      spawner,
    })
    await expect(provider.start(baseRequest())).rejects.toThrow(/OpenAI API key/)
  })

  it('builds exec argv with -C and --sandbox for a fresh run', async () => {
    const { spawner, calls, child } = fakeSpawner()
    const provider = new CodexAgentProvider({
      auth: { kind: 'cli-session' },
      sandboxMode: 'read-only',
      spawner,
    })
    const handle = await provider.start(
      baseRequest({
        workspace: {
          id: asId('ws-1'),
          strategy: 'local-directory',
          path: '/work',
          createdAt: new Date(),
        },
      }),
    )
    child.emitClose(0)
    await handle.result()

    const args = calls[0]?.args ?? []
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('-C')
    expect(args[args.indexOf('-C') + 1]).toBe('/work')
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args).toContain('--skip-git-repo-check')
  })
})

describe('CodexAgentProvider.resume', () => {
  it('builds a resume argv without -C or --sandbox', async () => {
    const { spawner, calls, child } = fakeSpawner()
    const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
    const handle = await provider.resume('thread-old', baseRequest())
    child.emitClose(0)
    await handle.result()

    const args = calls[0]?.args ?? []
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'thread-old', '--json'])
    expect(args).not.toContain('-C')
    expect(args).not.toContain('--sandbox')
    expect(args).not.toContain('--skip-git-repo-check')
  })
})

describe('CodexAgentProvider.detect', () => {
  it('reports installed:false when the binary is missing', async () => {
    const provider = new CodexAgentProvider({
      auth: { kind: 'cli-session' },
      runner: async () => {
        throw new Error('ENOENT')
      },
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: false, available: false })
  })

  it('reports authenticated:true for cli-session when login status says logged in', async () => {
    const provider = new CodexAgentProvider({
      auth: { kind: 'cli-session' },
      runner: async (args) =>
        args[0] === '--version' ? 'codex-cli 0.147.0' : 'Logged in using ChatGPT',
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: true, available: true })
  })

  it('reports available:true for api-key auth when a key resolves', async () => {
    const provider = new CodexAgentProvider({
      auth: { kind: 'api-key', apiKey: async () => 'sk-oai' },
      runner: async () => 'codex-cli 0.147.0',
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ installed: true, authenticated: true, available: true })
  })
})

describe('environment hygiene (ADR-0016)', () => {
  it('does not inherit ambient daemon environment variables', async () => {
    process.env.OVERTURE_AMBIENT_SECRET = 'leak-me'
    try {
      const { spawner, calls, child } = fakeSpawner()
      const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })
      const handle = await provider.start(baseRequest())
      child.emitClose(0)
      await handle.result()
      const env = calls[0]?.options.env ?? {}
      expect(env.OVERTURE_AMBIENT_SECRET).toBeUndefined()
      expect(env.PATH).toBeDefined()
      expect(env.HOME).toBeDefined()
    } finally {
      delete process.env.OVERTURE_AMBIENT_SECRET
    }
  })
})
