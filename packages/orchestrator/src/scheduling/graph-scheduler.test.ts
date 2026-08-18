import {
  type Clock,
  DefinitionKind,
  type IdGenerator,
  InMemoryEventBus,
  type LaneDefinition,
  noopLogger,
  type OrchestratorEvent,
  type PersistenceProvider,
  type Run,
  type RunId,
  RunState,
  type WorkItem,
} from '@overture/core'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import {
  GraphScheduler,
  nextFireTime,
  parseScheduleSpec,
  type WorkflowStartPort,
} from './graph-scheduler.js'

class FakeClock implements Clock {
  constructor(private millis: number) {}
  now(): Date {
    return new Date(this.millis)
  }
  advance(ms: number): void {
    this.millis += ms
  }
}

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

/** Records start calls and persists a run in the requested state. */
class FakeStarter implements WorkflowStartPort {
  readonly calls: Array<{ readonly item: WorkItem; readonly workflow: string }> = []
  constructor(
    private readonly persistence: PersistenceProvider,
    private readonly clock: Clock,
    private readonly finalState: RunState = RunState.Running,
  ) {}

  async start(
    item: WorkItem,
    workflowName: string,
    runId: RunId,
    options?: { readonly variables?: Readonly<Record<string, unknown>> },
  ): Promise<Run> {
    void options
    this.calls.push({ item, workflow: workflowName })
    const run: Run = {
      id: runId,
      workItemId: item.id,
      workflowName,
      state: this.finalState,
      sessionIds: [],
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      history: [],
    }
    await this.persistence.runs.save(run)
    return run
  }
}

const MONDAY_0800 = Date.UTC(2026, 0, 5, 8, 0, 0)
const isLabelBlocked = (item: WorkItem): boolean => item.labels.includes('blocked')

interface Harness {
  scheduler: GraphScheduler
  persistence: PersistenceProvider
  starter: FakeStarter
  clock: FakeClock
  events: OrchestratorEvent[]
  restart: () => GraphScheduler
}

function harness(options: { finalState?: RunState } = {}): Harness {
  const clock = new FakeClock(MONDAY_0800)
  const persistence = new InMemoryPersistenceProvider({ clock })
  const starter = new FakeStarter(persistence, clock, options.finalState)
  const events: OrchestratorEvent[] = []
  const bus = new InMemoryEventBus()
  bus.subscribe({}, (event) => events.push(event))
  const make = (): GraphScheduler =>
    new GraphScheduler({
      persistence,
      starter,
      events: bus,
      clock,
      ids: new SequentialIds(),
      logger: noopLogger,
      isBlocked: isLabelBlocked,
    })
  return { scheduler: make(), persistence, starter, clock, events, restart: make }
}

function lane(overrides: Partial<LaneDefinition>): LaneDefinition {
  return {
    name: 'lane-1',
    source: 'fake',
    workflow: 'build-flow',
    policy: 'strict_serial',
    maxActive: 1,
    enabled: true,
    ...overrides,
  }
}

describe('GraphScheduler lane dispatch', () => {
  it('strict_serial starts only the top-ranked item', async () => {
    const h = harness()
    const items = [makeWorkItem({ externalId: 'A' }), makeWorkItem({ externalId: 'B' })]
    const report = await h.scheduler.dispatchLane(lane({ policy: 'strict_serial' }), items)

    expect(report.started).toHaveLength(1)
    expect(h.starter.calls.map((call) => call.item.externalId)).toEqual(['A'])
    expect(report.skipped).toHaveLength(0)
    expect(report.halted).toBeUndefined()
  })

  it('strict_serial halts when the top item is blocked and records why', async () => {
    const h = harness()
    const items = [
      makeWorkItem({ externalId: 'A', labels: ['blocked'] }),
      makeWorkItem({ externalId: 'B' }),
    ]
    const report = await h.scheduler.dispatchLane(lane({ policy: 'strict_serial' }), items)

    expect(report.started).toHaveLength(0)
    expect(report.halted?.item.externalId).toBe('A')
    expect(report.halted?.reason).toBe('item is blocked')
    expect(
      h.events.some((event) => event.type === 'work.updated' && event.detail.includes('halted')),
    ).toBe(true)
    expect(h.starter.calls).toHaveLength(0)
  })

  it('strict_serial keeps at most one active run, durably across restarts', async () => {
    const h = harness() // runs stay RUNNING
    const first = await h.scheduler.dispatchLane(lane({}), [makeWorkItem({ externalId: 'A' })])
    expect(first.started).toHaveLength(1)

    // A fresh scheduler over the same persistence sees the active run.
    const restarted = h.restart()
    const second = await restarted.dispatchLane(lane({}), [makeWorkItem({ externalId: 'B' })])
    expect(second.started).toHaveLength(0)

    // Once the run reaches a terminal state the lane frees up.
    const active = first.started[0] as Run
    await h.persistence.runs.save({ ...active, state: RunState.Completed })
    const third = await restarted.dispatchLane(lane({}), [makeWorkItem({ externalId: 'B' })])
    expect(third.started).toHaveLength(1)
    expect(h.starter.calls.map((call) => call.item.externalId)).toEqual(['A', 'B'])
  })

  it('skip_blocked skips blocked items in rank order with an event per skip', async () => {
    const h = harness()
    const items = [
      makeWorkItem({ externalId: 'A', labels: ['blocked'] }),
      makeWorkItem({ externalId: 'B', labels: ['blocked'] }),
      makeWorkItem({ externalId: 'C' }),
      makeWorkItem({ externalId: 'D' }),
    ]
    const report = await h.scheduler.dispatchLane(lane({ policy: 'skip_blocked' }), items)

    expect(report.skipped.map((entry) => entry.item.externalId)).toEqual(['A', 'B'])
    expect(h.starter.calls.map((call) => call.item.externalId)).toEqual(['C'])
    expect(
      h.events.filter((event) => event.type === 'work.updated' && event.detail.includes('skipped')),
    ).toHaveLength(2)
  })

  it('ranked_parallel fills up to maxActive in rank order, never reordering', async () => {
    const h = harness()
    // Priorities deliberately inverted: rank order must win.
    const items = [
      makeWorkItem({ externalId: 'A', priority: 'low' }),
      makeWorkItem({ externalId: 'B', labels: ['blocked'], priority: 'urgent' }),
      makeWorkItem({ externalId: 'C', priority: 'medium' }),
      makeWorkItem({ externalId: 'D', priority: 'urgent' }),
    ]
    const report = await h.scheduler.dispatchLane(
      lane({ policy: 'ranked_parallel', maxActive: 2 }),
      items,
    )

    expect(h.starter.calls.map((call) => call.item.externalId)).toEqual(['A', 'C'])
    expect(report.skipped.map((entry) => entry.item.externalId)).toEqual(['B'])
  })

  it('a lane without a workflow routes items and halts on ambiguity instead of guessing', async () => {
    const h = harness()
    const routingLane: LaneDefinition = {
      name: 'routed',
      source: 'fake',
      policy: 'strict_serial',
      maxActive: 1,
      enabled: true,
    }
    const item = makeWorkItem({ externalId: 'A', labels: ['infra'] })
    await h.persistence.config.set('routing', 'rule:r1', {
      name: 'r1',
      condition: 'item.labels.infra',
      workflow: 'infra-flow',
    })
    await h.persistence.config.set('routing', 'rule:r2', {
      name: 'r2',
      condition: 'item.labels.infra',
      workflow: 'ops-flow',
    })
    for (const name of ['infra-flow', 'ops-flow']) {
      await h.persistence.definitions.save(DefinitionKind.Workflow, name, { name })
      await h.persistence.definitions.setLifecycle(DefinitionKind.Workflow, name, 'enabled')
    }

    const report = await h.scheduler.dispatchLane(routingLane, [item])
    expect(report.started).toHaveLength(0)
    expect(report.halted?.reason).toBe('workflow selection required')
    const open = await h.persistence.waits.listOpen({})
    expect(open).toHaveLength(1)
    expect(open[0]?.parameters.reason).toBe('WORKFLOW_SELECTION_REQUIRED')
  })

  it('a disabled lane dispatches nothing', async () => {
    const h = harness()
    const report = await h.scheduler.dispatchLane(lane({ enabled: false }), [makeWorkItem({})])
    expect(report.started).toHaveLength(0)
    expect(h.starter.calls).toHaveLength(0)
  })
})

describe('GraphScheduler recurring schedules', () => {
  async function saveSchedule(
    persistence: PersistenceProvider,
    name: string,
    cron: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await persistence.definitions.save(DefinitionKind.Schedule, name, {
      name,
      cron,
      workflow: 'report-flow',
      enabled: true,
      ...(payload ? { payload } : {}),
    })
    await persistence.definitions.setLifecycle(DefinitionKind.Schedule, name, 'enabled')
  }

  it('fires interval schedules once per due slot and starts the workflow', async () => {
    const h = harness()
    await saveSchedule(h.persistence, 'quarter-hourly', 'every 15m', { report: 'usage' })

    expect(await h.scheduler.fireDueSchedules(new Date(MONDAY_0800 + 10 * 60_000))).toBe(0)
    expect(await h.scheduler.fireDueSchedules(new Date(MONDAY_0800 + 30 * 60_000))).toBe(1)
    // Same scan time again: the slot already fired.
    expect(await h.scheduler.fireDueSchedules(new Date(MONDAY_0800 + 30 * 60_000))).toBe(0)

    expect(h.starter.calls).toHaveLength(1)
    const call = h.starter.calls[0]
    expect(call?.workflow).toBe('report-flow')
    expect(call?.item.provider).toBe('schedule')
    expect(call?.item.metadata.scheduleName).toBe('quarter-hourly')
  })

  it('does not double-fire across scheduler restarts', async () => {
    const h = harness()
    await saveSchedule(h.persistence, 'quarter-hourly', 'every 15m')
    const now = new Date(MONDAY_0800 + 30 * 60_000)
    expect(await h.scheduler.fireDueSchedules(now)).toBe(1)

    const restarted = h.restart()
    expect(await restarted.fireDueSchedules(now)).toBe(0)
    expect(h.starter.calls).toHaveLength(1)
  })

  it('collapses downtime to one catch-up firing at the latest missed slot', async () => {
    const h = harness()
    await saveSchedule(h.persistence, 'daily', '30 9 * * *')

    expect(await h.scheduler.fireDueSchedules(new Date(Date.UTC(2026, 0, 5, 9, 0)))).toBe(0)
    expect(await h.scheduler.fireDueSchedules(new Date(Date.UTC(2026, 0, 5, 9, 31)))).toBe(1)
    // Three days of downtime: exactly one catch-up firing for Jan 8 09:30.
    expect(await h.scheduler.fireDueSchedules(new Date(Date.UTC(2026, 0, 8, 10, 0)))).toBe(1)
    const last = await h.persistence.schedules.lastFiring('daily')
    expect(last?.dueAt.toISOString()).toBe('2026-01-08T09:30:00.000Z')
  })

  it('skips schedules that are disabled at either level', async () => {
    const h = harness()
    await saveSchedule(h.persistence, 'off-lifecycle', 'every 1m')
    await h.persistence.definitions.setLifecycle(
      DefinitionKind.Schedule,
      'off-lifecycle',
      'disabled',
    )
    await h.persistence.definitions.save(DefinitionKind.Schedule, 'off-flag', {
      name: 'off-flag',
      cron: 'every 1m',
      workflow: 'report-flow',
      enabled: false,
    })
    await h.persistence.definitions.setLifecycle(DefinitionKind.Schedule, 'off-flag', 'enabled')

    expect(await h.scheduler.fireDueSchedules(new Date(MONDAY_0800 + 3_600_000))).toBe(0)
  })
})

describe('schedule spec parsing and nextFireTime', () => {
  it('computes interval fire times', () => {
    const spec = parseScheduleSpec('@every 5m')
    expect(nextFireTime(spec, new Date(MONDAY_0800)).toISOString()).toBe('2026-01-05T08:05:00.000Z')
  })

  it('computes cron fire times at minute precision in UTC', () => {
    const hourly = parseScheduleSpec('0 * * * *')
    expect(nextFireTime(hourly, new Date(Date.UTC(2026, 0, 5, 8, 15))).toISOString()).toBe(
      '2026-01-05T09:00:00.000Z',
    )
    const step = parseScheduleSpec('*/10 * * * *')
    expect(nextFireTime(step, new Date(Date.UTC(2026, 0, 5, 8, 5))).toISOString()).toBe(
      '2026-01-05T08:10:00.000Z',
    )
    // 2026-01-05 is a Monday; the next Monday 09:30 is Jan 12.
    const weekly = parseScheduleSpec('30 9 * * 1')
    expect(nextFireTime(weekly, new Date(Date.UTC(2026, 0, 5, 9, 31))).toISOString()).toBe(
      '2026-01-12T09:30:00.000Z',
    )
  })

  it('rejects malformed specs', () => {
    expect(() => parseScheduleSpec('not a spec')).toThrow()
    expect(() => parseScheduleSpec('60 * * * *')).toThrow()
    expect(() => parseScheduleSpec('every 0m')).toThrow()
  })
})
