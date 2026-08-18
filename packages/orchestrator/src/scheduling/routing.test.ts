import {
  type Clock,
  type IdGenerator,
  InMemoryEventBus,
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
import { GraphScheduler, type WorkflowStartPort } from './graph-scheduler.js'
import {
  type RoutingDecision,
  type RoutingRule,
  routeItem,
  suggestRoutingRules,
} from './routing.js'

class FakeClock implements Clock {
  constructor(private millis: number) {}
  now(): Date {
    return new Date(this.millis)
  }
}

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

class FakeStarter implements WorkflowStartPort {
  readonly calls: Array<{ readonly item: WorkItem; readonly workflow: string }> = []
  constructor(
    private readonly persistence: PersistenceProvider,
    private readonly clock: Clock,
  ) {}

  async start(item: WorkItem, workflowName: string, runId: RunId): Promise<Run> {
    this.calls.push({ item, workflow: workflowName })
    const run: Run = {
      id: runId,
      workItemId: item.id,
      workflowName,
      state: RunState.Running,
      sessionIds: [],
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      history: [],
    }
    await this.persistence.runs.save(run)
    return run
  }
}

const WORKFLOWS = ['infra-flow', 'ops-flow', 'docs-flow']
const rule = (
  name: string,
  condition: string,
  workflow: string,
  autoStart?: boolean,
): RoutingRule => ({
  name,
  condition,
  workflow,
  ...(autoStart !== undefined ? { autoStart } : {}),
})

function harness(): {
  scheduler: GraphScheduler
  persistence: PersistenceProvider
  starter: FakeStarter
  events: OrchestratorEvent[]
} {
  const clock = new FakeClock(Date.UTC(2026, 0, 5, 8, 0, 0))
  const persistence = new InMemoryPersistenceProvider({ clock })
  const starter = new FakeStarter(persistence, clock)
  const events: OrchestratorEvent[] = []
  const bus = new InMemoryEventBus()
  bus.subscribe({}, (event) => events.push(event))
  const scheduler = new GraphScheduler({
    persistence,
    starter,
    events: bus,
    clock,
    ids: new SequentialIds(),
    logger: noopLogger,
  })
  return { scheduler, persistence, starter, events }
}

describe('routeItem', () => {
  const infra = makeWorkItem({ externalId: 'R-1', labels: ['infra'], type: 'task' })

  it('returns no-match when nothing applies', () => {
    expect(routeItem(infra, [rule('r', 'item.labels.docs', 'docs-flow')], WORKFLOWS)).toEqual({
      kind: 'no-match',
    })
  })

  it('returns a unique match with its rule', () => {
    const only = rule('r', 'item.labels.infra', 'infra-flow', true)
    const outcome = routeItem(infra, [only], WORKFLOWS)
    expect(outcome).toEqual({ kind: 'unique', workflow: 'infra-flow', rule: only })
  })

  it('treats multiple rules agreeing on one workflow as unique', () => {
    const outcome = routeItem(
      infra,
      [
        rule('a', 'item.labels.infra', 'infra-flow'),
        rule('b', "item.type == 'task'", 'infra-flow'),
      ],
      WORKFLOWS,
    )
    expect(outcome.kind).toBe('unique')
  })

  it('returns ambiguous for distinct matching workflows and ignores disabled ones', () => {
    const rules = [
      rule('a', 'item.labels.infra', 'infra-flow'),
      rule('b', 'item.labels.infra', 'ops-flow'),
      rule('c', 'item.labels.infra', 'retired-flow'),
    ]
    const outcome = routeItem(infra, rules, WORKFLOWS)
    expect(outcome).toEqual({ kind: 'ambiguous', workflows: ['infra-flow', 'ops-flow'] })
  })
})

describe('GraphScheduler routing dispatch', () => {
  const ambiguousRules = [
    rule('a', 'item.labels.infra', 'infra-flow'),
    rule('b', 'item.labels.infra', 'ops-flow'),
  ]

  it('does nothing but emit an event on no-match', async () => {
    const h = harness()
    const result = await h.scheduler.route(makeWorkItem({ externalId: 'X-1' }), {
      rules: ambiguousRules,
      enabledWorkflows: WORKFLOWS,
    })
    expect(result.outcome.kind).toBe('no-match')
    expect(result.runId).toBeUndefined()
    expect(h.starter.calls).toHaveLength(0)
    expect(
      h.events.some(
        (event) => event.type === 'work.updated' && event.detail.includes('no matching rule'),
      ),
    ).toBe(true)
  })

  it('starts a unique match only when the rule says autoStart', async () => {
    const h = harness()
    const item = makeWorkItem({ externalId: 'X-2', labels: ['infra'] })

    const manual = await h.scheduler.route(item, {
      rules: [rule('a', 'item.labels.infra', 'infra-flow')],
      enabledWorkflows: WORKFLOWS,
    })
    expect(manual.outcome.kind).toBe('unique')
    expect(h.starter.calls).toHaveLength(0)

    const auto = await h.scheduler.route(item, {
      rules: [rule('a', 'item.labels.infra', 'infra-flow', true)],
      enabledWorkflows: WORKFLOWS,
    })
    expect(auto.runId).toBeDefined()
    expect(h.starter.calls.map((call) => call.workflow)).toEqual(['infra-flow'])
  })

  it('opens one durable single-choice wait per ambiguous item', async () => {
    const h = harness()
    const item = makeWorkItem({ externalId: 'X-3', labels: ['infra'] })
    const first = await h.scheduler.route(item, {
      rules: ambiguousRules,
      enabledWorkflows: WORKFLOWS,
    })
    expect(first.outcome.kind).toBe('ambiguous')
    expect(first.waitId).toBeDefined()

    const wait = await h.persistence.waits.get(first.waitId ?? '')
    expect(wait?.parameters.reason).toBe('WORKFLOW_SELECTION_REQUIRED')
    expect(wait?.request?.type).toBe('single-choice')
    expect(wait?.request?.surface).toBe('app')
    expect(wait?.request?.choices).toEqual(['infra-flow', 'ops-flow'])
    expect(h.events.some((event) => event.type === 'routing.selection_required')).toBe(true)

    // Re-routing the same item reuses the open wait instead of stacking.
    const second = await h.scheduler.route(item, {
      rules: ambiguousRules,
      enabledWorkflows: WORKFLOWS,
    })
    expect(second.waitId).toBe(first.waitId)
    expect(h.starter.calls).toHaveLength(0)
  })

  it('selection starts the chosen workflow and records the decision', async () => {
    const h = harness()
    const item = makeWorkItem({ externalId: 'X-4', labels: ['infra'], type: 'task' })
    const routed = await h.scheduler.route(item, {
      rules: ambiguousRules,
      enabledWorkflows: WORKFLOWS,
    })
    const waitId = routed.waitId ?? ''

    const invalid = await h.scheduler.onSelection(waitId, {
      workflow: 'docs-flow', // not among the candidates
      responder: 'terry',
    })
    expect(invalid.accepted).toBe(false)

    const accepted = await h.scheduler.onSelection(waitId, {
      workflow: 'ops-flow',
      responder: 'terry',
    })
    expect(accepted.accepted).toBe(true)
    expect(accepted.runId).toBeDefined()
    expect(h.starter.calls.map((call) => call.workflow)).toEqual(['ops-flow'])

    const decisions = await h.scheduler.listDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.chosenWorkflow).toBe('ops-flow')
    expect(decisions[0]?.characteristics.labels).toEqual(['infra'])
    expect(decisions[0]?.characteristics.type).toBe('task')

    // First valid response won; a later one is supplemental context only.
    const late = await h.scheduler.onSelection(waitId, {
      workflow: 'infra-flow',
      responder: 'alex',
    })
    expect(late.accepted).toBe(false)
    expect(late.reason).toContain('supplemental')
    expect(h.starter.calls).toHaveLength(1)
  })
})

describe('routing-rule learning', () => {
  const decision = (
    id: string,
    workflow: string,
    characteristics: RoutingDecision['characteristics'],
  ): RoutingDecision => ({
    workItemId: id,
    characteristics,
    chosenWorkflow: workflow,
    responder: 'terry',
    at: '2026-01-05T08:00:00.000Z',
  })

  it('suggests nothing below three consistent selections', () => {
    const history = [
      decision('1', 'infra-flow', { labels: ['infra'] }),
      decision('2', 'infra-flow', { labels: ['infra'] }),
    ]
    expect(suggestRoutingRules(history)).toHaveLength(0)
  })

  it('suggests a rule for a discriminating attribute with consistent outcomes', () => {
    const history = [
      decision('1', 'infra-flow', { labels: ['infra'], type: 'task' }),
      decision('2', 'infra-flow', { labels: ['infra'] }),
      decision('3', 'infra-flow', { labels: ['infra'], repository: 'org/infra' }),
      decision('4', 'docs-flow', { labels: ['docs'] }),
    ]
    const suggestions = suggestRoutingRules(history)
    expect(suggestions).toEqual([
      {
        attribute: { field: 'label', value: 'infra' },
        condition: 'item.labels.infra',
        workflow: 'infra-flow',
        evidenceCount: 3,
      },
    ])
  })

  it('does not suggest attributes with inconsistent outcomes', () => {
    const history = [
      decision('1', 'infra-flow', { labels: ['infra'] }),
      decision('2', 'infra-flow', { labels: ['infra'] }),
      decision('3', 'ops-flow', { labels: ['infra'] }),
    ]
    expect(suggestRoutingRules(history)).toHaveLength(0)
  })

  it('persists a suggested rule only after explicit approval', async () => {
    const h = harness()
    const ambiguousRules = [
      rule('a', 'item.labels.infra', 'infra-flow'),
      rule('b', 'item.labels.infra', 'ops-flow'),
    ]
    for (const externalId of ['L-1', 'L-2', 'L-3']) {
      const item = makeWorkItem({ externalId, labels: ['infra'] })
      const routed = await h.scheduler.route(item, {
        rules: ambiguousRules,
        enabledWorkflows: WORKFLOWS,
      })
      await h.scheduler.onSelection(routed.waitId ?? '', {
        workflow: 'infra-flow',
        responder: 'terry',
      })
    }

    const suggestions = await h.scheduler.suggestRules()
    expect(suggestions).toHaveLength(1)
    const suggestion = suggestions[0]
    expect(suggestion?.evidenceCount).toBe(3)
    if (!suggestion) throw new Error('expected a suggestion')

    // Rejection persists nothing.
    const firstWait = await h.scheduler.proposeRule(suggestion)
    const rejected = await h.scheduler.onRuleApproval(firstWait, {
      approved: false,
      responder: 'terry',
    })
    expect(rejected).toEqual({ accepted: true, persisted: false })
    expect(await h.scheduler.listRules()).toHaveLength(0)

    // Approval persists the rule; it now routes uniquely, without autoStart.
    const secondWait = await h.scheduler.proposeRule(suggestion)
    expect(secondWait).not.toBe(firstWait)
    const approved = await h.scheduler.onRuleApproval(secondWait, {
      approved: true,
      responder: 'terry',
    })
    expect(approved).toEqual({ accepted: true, persisted: true })
    const rules = await h.scheduler.listRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.autoStart).toBe(false)

    const startsBefore = h.starter.calls.length
    const routed = await h.scheduler.route(makeWorkItem({ externalId: 'L-4', labels: ['infra'] }), {
      enabledWorkflows: WORKFLOWS,
    })
    expect(routed.outcome.kind).toBe('unique')
    expect(h.starter.calls).toHaveLength(startsBefore)
  })

  it('never applies a suggestion without approval', async () => {
    const h = harness()
    const suggestions = suggestRoutingRules([
      decision('1', 'infra-flow', { labels: ['infra'] }),
      decision('2', 'infra-flow', { labels: ['infra'] }),
      decision('3', 'infra-flow', { labels: ['infra'] }),
    ])
    expect(suggestions).toHaveLength(1)
    // Proposing opens an approval wait but changes no routing behavior.
    const suggestion = suggestions[0]
    if (!suggestion) throw new Error('expected a suggestion')
    await h.scheduler.proposeRule(suggestion)
    expect(await h.scheduler.listRules()).toHaveLength(0)
    const routed = await h.scheduler.route(makeWorkItem({ externalId: 'N-1', labels: ['infra'] }), {
      enabledWorkflows: WORKFLOWS,
    })
    expect(routed.outcome.kind).toBe('no-match')
  })
})
