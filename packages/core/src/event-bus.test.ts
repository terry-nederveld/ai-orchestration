import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from './event-bus.js'
import type { OrchestratorEvent } from './events.js'
import { asId, type RunId } from './ids.js'

const event = (type: 'work.discovered' | 'workspace.cleaned', runId?: string): OrchestratorEvent =>
  ({
    id: asId('e1'),
    at: new Date('2026-08-14T00:00:00Z'),
    ...(runId ? { runId: asId<'run'>(runId) } : {}),
    ...(type === 'work.discovered'
      ? { type, workItemId: 'w1', provider: 'fake' }
      : { type, workspaceId: 'ws1' }),
  }) as OrchestratorEvent

describe('InMemoryEventBus', () => {
  it('delivers events to matching subscribers', () => {
    const bus = new InMemoryEventBus()
    const seen: string[] = []
    bus.subscribe({ types: ['work.discovered'] }, (e) => seen.push(e.type))
    bus.publish(event('work.discovered'))
    bus.publish(event('workspace.cleaned'))
    expect(seen).toEqual(['work.discovered'])
  })

  it('filters by runId', () => {
    const bus = new InMemoryEventBus()
    const seen: (RunId | undefined)[] = []
    bus.subscribe({ runId: asId<'run'>('r1') }, (e) => seen.push(e.runId))
    bus.publish(event('work.discovered', 'r1'))
    bus.publish(event('work.discovered', 'r2'))
    expect(seen).toEqual(['r1'])
  })

  it('unsubscribes cleanly', () => {
    const bus = new InMemoryEventBus()
    let count = 0
    const unsubscribe = bus.subscribe({}, () => count++)
    bus.publish(event('work.discovered'))
    unsubscribe()
    bus.publish(event('work.discovered'))
    expect(count).toBe(1)
  })

  it('isolates throwing handlers', () => {
    const bus = new InMemoryEventBus()
    let delivered = false
    bus.subscribe({}, () => {
      throw new Error('boom')
    })
    bus.subscribe({}, () => {
      delivered = true
    })
    bus.publish(event('work.discovered'))
    expect(delivered).toBe(true)
  })
})
