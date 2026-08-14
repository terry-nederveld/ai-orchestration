import type { HookContext, HookOutcome } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { DefaultHookRegistry } from './hook-registry.js'
import { RecordingLogger } from './test-logger.js'

function ctx(point: HookContext['point'] = 'before_tool_call'): HookContext {
  return { point, payload: {} }
}

describe('DefaultHookRegistry', () => {
  it('runs handlers in registration order', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })
    const order: string[] = []

    registry.register(
      'before_tool_call',
      async () => {
        order.push('a')
        return { action: 'continue' }
      },
      'ext.a',
    )
    registry.register(
      'before_tool_call',
      async () => {
        order.push('b')
        return { action: 'continue' }
      },
      'ext.b',
    )

    await registry.run(ctx())
    expect(order).toEqual(['a', 'b'])
  })

  it('only runs handlers registered for the matching hook point', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })
    let calls = 0

    registry.register(
      'after_tool_call',
      async () => {
        calls += 1
        return { action: 'continue' }
      },
      'ext.a',
    )

    await registry.run(ctx('before_tool_call'))
    expect(calls).toBe(0)
  })

  it('first block wins and short-circuits later handlers', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })
    let thirdCalled = false

    registry.register('before_tool_call', async () => ({ action: 'continue' }), 'ext.a')
    registry.register(
      'before_tool_call',
      async () => ({ action: 'block', reason: 'nope' }) satisfies HookOutcome,
      'ext.b',
    )
    registry.register(
      'before_tool_call',
      async () => {
        thirdCalled = true
        return { action: 'continue' }
      },
      'ext.c',
    )

    const outcome = await registry.run(ctx())
    expect(outcome.action).toBe('block')
    expect(outcome.reason).toBe('nope')
    expect(thirdCalled).toBe(false)
  })

  it('shallow-merges amend payloads across handlers', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })

    registry.register(
      'before_tool_call',
      async () => ({ action: 'continue', amend: { a: 1 } }),
      'ext.a',
    )
    registry.register(
      'before_tool_call',
      async () => ({ action: 'continue', amend: { b: 2, a: 99 } }),
      'ext.b',
    )

    const outcome = await registry.run(ctx())
    expect(outcome.action).toBe('continue')
    expect(outcome.amend).toEqual({ a: 99, b: 2 })
  })

  it('merges amends collected before a block into the block outcome', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })

    registry.register(
      'before_tool_call',
      async () => ({ action: 'continue', amend: { a: 1 } }),
      'ext.a',
    )
    registry.register(
      'before_tool_call',
      async () => ({ action: 'block', amend: { b: 2 } }) satisfies HookOutcome,
      'ext.b',
    )

    const outcome = await registry.run(ctx())
    expect(outcome).toEqual({ action: 'block', amend: { a: 1, b: 2 } })
  })

  it('treats a throwing handler as continue and logs it', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })
    let secondCalled = false

    registry.register(
      'before_tool_call',
      async () => {
        throw new Error('boom')
      },
      'ext.crashy',
    )
    registry.register(
      'before_tool_call',
      async () => {
        secondCalled = true
        return { action: 'continue' }
      },
      'ext.ok',
    )

    const outcome = await registry.run(ctx())
    expect(outcome.action).toBe('continue')
    expect(secondCalled).toBe(true)
    expect(
      logger.entries.some((e) => e.level === 'error' && e.fields?.source === 'ext.crashy'),
    ).toBe(true)
  })

  it('skips a handler that exceeds its timeout and logs a warning', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger, timeoutMs: 20 })
    let secondCalled = false

    registry.register(
      'before_tool_call',
      () => new Promise<HookOutcome>(() => {}), // never resolves
      'ext.slow',
    )
    registry.register(
      'before_tool_call',
      async () => {
        secondCalled = true
        return { action: 'continue' }
      },
      'ext.ok',
    )

    const outcome = await registry.run(ctx())
    expect(outcome.action).toBe('continue')
    expect(secondCalled).toBe(true)
    expect(logger.entries.some((e) => e.level === 'warn' && e.fields?.source === 'ext.slow')).toBe(
      true,
    )
  })

  it('defaults the per-handler timeout to 10 seconds', () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger }) as unknown as { timeoutMs: number }
    expect(registry.timeoutMs).toBe(10_000)
  })

  it('unregister removes the handler', async () => {
    const logger = new RecordingLogger()
    const registry = new DefaultHookRegistry({ logger })
    let calls = 0

    const unregister = registry.register(
      'before_tool_call',
      async () => {
        calls += 1
        return { action: 'continue' }
      },
      'ext.a',
    )

    unregister()
    await registry.run(ctx())
    expect(calls).toBe(0)
  })
})
