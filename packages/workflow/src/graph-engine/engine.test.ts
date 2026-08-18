import {
  asId,
  type GraphNode,
  type GraphTransition,
  initialRunGraphState,
  type RunGraphState,
  validateGraph,
  type WorkflowGraph,
} from '@overture/core'
import { describe, expect, it } from 'vitest'
import {
  GraphEngine,
  type GraphEngineEvent,
  type GraphNodeExecutors,
  type GraphTickOutcome,
  type NodeYield,
} from './engine.js'

const runId = asId<'run'>('run-1')

function graph(
  nodes: GraphNode[],
  transitions: GraphTransition[],
  entry = nodes[0]?.id ?? 'start',
): WorkflowGraph {
  const g: WorkflowGraph = { name: 'test', entry, nodes, transitions }
  const issues = validateGraph(g)
  if (issues.length > 0) {
    throw new Error(`invalid test graph: ${issues.map((issue) => issue.message).join('; ')}`)
  }
  return g
}

const agent = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  config: { kind: 'agent', goal: id },
  ...extra,
})

const terminal = (
  id: string,
  outcome: 'completed' | 'failed' | 'blocked' = 'completed',
): GraphNode => ({ id, config: { kind: 'terminal', outcome } })

const t = (
  id: string,
  from: string,
  to: string,
  extra: Partial<GraphTransition> = {},
): GraphTransition => ({ id, from, to, ...extra })

/** Executors returning scripted yields per node id (call-counted). */
function scripted(script: Record<string, NodeYield | NodeYield[]>): {
  executors: GraphNodeExecutors
  calls: Record<string, number>
} {
  const calls: Record<string, number> = {}
  const perNodeQueue = new Map<string, NodeYield[]>()
  const executor = async (node: GraphNode): Promise<NodeYield> => {
    calls[node.id] = (calls[node.id] ?? 0) + 1
    const entry = script[node.id]
    if (entry === undefined) return { type: 'result', status: 'succeeded', outputs: {} }
    if (Array.isArray(entry)) {
      const queue = perNodeQueue.get(node.id) ?? [...entry]
      const next = queue.shift() ?? entry[entry.length - 1]
      perNodeQueue.set(node.id, queue)
      return next as NodeYield
    }
    return entry
  }
  const executors: GraphNodeExecutors = {
    agent: executor,
    command: executor,
    action: executor,
    'human-input': async (node, context) => {
      calls[node.id] = (calls[node.id] ?? 0) + 1
      if (context.satisfaction) {
        return {
          type: 'result',
          status: 'succeeded',
          outputs: { value: context.satisfaction.input?.value },
        }
      }
      return {
        type: 'wait',
        spec: { kind: 'human-input', parameters: {} },
        request: node.config.kind === 'human-input' ? node.config.request : undefined,
      }
    },
    wait: async (node, context) => {
      calls[node.id] = (calls[node.id] ?? 0) + 1
      if (context.satisfaction) {
        return {
          type: 'result',
          status: 'succeeded',
          outputs: { event: context.satisfaction.event },
        }
      }
      return {
        type: 'wait',
        spec:
          node.config.kind === 'wait' ? node.config.condition : { kind: 'time', parameters: {} },
      }
    },
    terminal: async (node) => {
      calls[node.id] = (calls[node.id] ?? 0) + 1
      return { type: 'result', status: 'succeeded', outputs: {} }
    },
  }
  return { executors, calls }
}

/** Serialize/deserialize state between ticks to prove durability. */
function roundTrip(state: RunGraphState): RunGraphState {
  const parsed = JSON.parse(JSON.stringify(state)) as RunGraphState
  return {
    ...parsed,
    resultHistory: parsed.resultHistory.map((result) => ({
      ...result,
      startedAt: new Date(result.startedAt),
      settledAt: new Date(result.settledAt),
    })),
    nodeResults: Object.fromEntries(
      Object.entries(parsed.nodeResults).map(([key, result]) => [
        key,
        { ...result, startedAt: new Date(result.startedAt), settledAt: new Date(result.settledAt) },
      ]),
    ),
    updatedAt: new Date(parsed.updatedAt),
  }
}

const engine = new GraphEngine()

async function run(
  g: WorkflowGraph,
  executors: GraphNodeExecutors,
  state = initialRunGraphState(runId, 'snap-1'),
): Promise<GraphTickOutcome> {
  return engine.tick({ graph: g, state, executors })
}

describe('GraphEngine basics', () => {
  it('runs a linear graph to a completed terminal', async () => {
    const g = graph(
      [agent('a'), agent('b'), terminal('end')],
      [t('t1', 'a', 'b'), t('t2', 'b', 'end')],
      'a',
    )
    const { executors, calls } = scripted({})
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(outcome.terminal?.outcome).toBe('completed')
    expect(calls).toEqual({ a: 1, b: 1, end: 1 })
    expect(outcome.state.nodeResults.a?.status).toBe('succeeded')
  })

  it('selects among declared transitions using structured outputs', async () => {
    const g = graph(
      [agent('triage'), agent('fast'), agent('deep'), terminal('end')],
      [
        t('to-fast', 'triage', 'fast', { condition: "outputs.complexity == 'small'" }),
        t('to-deep', 'triage', 'deep', { condition: "outputs.complexity == 'large'" }),
        t('f-end', 'fast', 'end'),
        t('d-end', 'deep', 'end'),
      ],
      'triage',
    )
    const { executors, calls } = scripted({
      triage: { type: 'result', status: 'succeeded', outputs: { complexity: 'large' } },
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.deep).toBe(1)
    expect(calls.fast).toBeUndefined()
  })

  it('fails the run when a succeeded node has no matching transition (stall)', async () => {
    const g = graph(
      [agent('a'), agent('b'), terminal('end')],
      [t('t1', 'a', 'b', { condition: "outputs.go == 'yes'" }), t('t2', 'b', 'end')],
      'a',
    )
    const { executors } = scripted({
      a: { type: 'result', status: 'succeeded', outputs: { go: 'no' } },
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('stalled')
  })

  it('routes declared failure transitions and fails hard without one', async () => {
    const routed = graph(
      [agent('work'), agent('remediate'), terminal('end')],
      [
        t('ok', 'work', 'end', { condition: "node.status == 'succeeded'" }),
        t('fix', 'work', 'remediate', { condition: "node.status == 'failed'" }),
        t('r-end', 'remediate', 'end'),
      ],
      'work',
    )
    const { executors, calls } = scripted({
      work: { type: 'result', status: 'failed', error: 'boom' },
    })
    const outcome = await run(routed, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.remediate).toBe(1)

    const unrouted = graph(
      [agent('work'), terminal('end')],
      [t('ok', 'work', 'end', { condition: "node.status == 'succeeded'" })],
      'work',
    )
    const { executors: executors2 } = scripted({
      work: { type: 'result', status: 'failed', error: 'boom' },
    })
    const failed = await run(unrouted, executors2)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain("node 'work' failed")
  })

  it('retries failing nodes up to maxAttempts before transitions fire', async () => {
    const g = graph(
      [agent('flaky', { retry: { maxAttempts: 3 } }), terminal('end')],
      [t('t1', 'flaky', 'end')],
      'flaky',
    )
    const { executors, calls } = scripted({
      flaky: [
        { type: 'result', status: 'failed', error: 'one' },
        { type: 'result', status: 'failed', error: 'two' },
        { type: 'result', status: 'succeeded', outputs: {} },
      ],
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.flaky).toBe(3)
    expect(outcome.state.resultHistory.filter((r) => r.nodeId === 'flaky')).toHaveLength(3)
    expect(outcome.state.nodeResults.flaky?.attempt).toBe(3)
  })
})

describe('GraphEngine loops and joins', () => {
  it('executes bounded loops and re-activates via any-join', async () => {
    const g = graph(
      [agent('step'), terminal('end')],
      [
        t('again', 'step', 'step', {
          condition: "outputs.done == 'no'",
          loopBound: 5,
        }),
        t('finish', 'step', 'end', { condition: "outputs.done == 'yes'" }),
      ],
      'step',
    )
    const { executors, calls } = scripted({
      step: [
        { type: 'result', status: 'succeeded', outputs: { done: 'no' } },
        { type: 'result', status: 'succeeded', outputs: { done: 'no' } },
        { type: 'result', status: 'succeeded', outputs: { done: 'yes' } },
      ],
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.step).toBe(3)
  })

  it('fails the run when a loop bound is exceeded', async () => {
    const g = graph(
      [agent('step'), terminal('end')],
      [
        t('again', 'step', 'step', { condition: "outputs.done == 'no'", loopBound: 2 }),
        t('finish', 'step', 'end', { condition: "outputs.done == 'yes'" }),
      ],
      'step',
    )
    const { executors } = scripted({
      step: { type: 'result', status: 'succeeded', outputs: { done: 'no' } },
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('loop bound exceeded')
  })

  it('all-join waits for every branch; diamond any-join fires once', async () => {
    const allJoin = graph(
      [
        agent('split'),
        agent('left'),
        agent('right'),
        agent('merge', { join: { mode: 'all' } }),
        terminal('end'),
      ],
      [
        t('s-l', 'split', 'left'),
        t('s-r', 'split', 'right'),
        t('l-m', 'left', 'merge'),
        t('r-m', 'right', 'merge'),
        t('m-e', 'merge', 'end'),
      ],
      'split',
    )
    const { executors, calls } = scripted({})
    const outcome = await run(allJoin, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.merge).toBe(1)

    const anyJoin = graph(
      [
        agent('split'),
        agent('left'),
        agent('right'),
        agent('merge', { join: { mode: 'any' } }),
        terminal('end'),
      ],
      [
        t('s-l', 'split', 'left'),
        t('s-r', 'split', 'right'),
        t('l-m', 'left', 'merge'),
        t('r-m', 'right', 'merge'),
        t('m-e', 'merge', 'end'),
      ],
      'split',
    )
    const { executors: executors2, calls: calls2 } = scripted({})
    const outcome2 = await run(anyJoin, executors2)
    expect(outcome2.status).toBe('completed')
    expect(calls2.merge).toBe(1)
  })

  it('min-join proceeds after n branches', async () => {
    const g = graph(
      [
        agent('split'),
        agent('a'),
        agent('b'),
        agent('c'),
        agent('merge', { join: { mode: 'min', n: 2 } }),
        terminal('end'),
      ],
      [
        t('s-a', 'split', 'a'),
        t('s-b', 'split', 'b'),
        t('s-c', 'split', 'c', { condition: 'false' }),
        t('a-m', 'a', 'merge'),
        t('b-m', 'b', 'merge'),
        t('c-m', 'c', 'merge'),
        t('m-e', 'merge', 'end'),
      ],
      'split',
    )
    const { executors, calls } = scripted({})
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.merge).toBe(1)
    expect(calls.c).toBeUndefined()
  })
})

describe('GraphEngine durable waits', () => {
  it('suspends on a wait, survives serialization, and resumes on satisfaction', async () => {
    const g = graph(
      [
        agent('before'),
        {
          id: 'ask',
          config: {
            kind: 'human-input',
            request: { type: 'text', prompt: 'which db?', surface: 'both' },
          },
        },
        agent('after'),
        terminal('end'),
      ],
      [t('t1', 'before', 'ask'), t('t2', 'ask', 'after'), t('t3', 'after', 'end')],
      'before',
    )
    const { executors, calls } = scripted({})

    const first = await run(g, executors)
    expect(first.status).toBe('waiting')
    expect(first.newWaits).toHaveLength(1)
    expect(first.newWaits[0]?.request?.prompt).toBe('which db?')
    expect(calls.after).toBeUndefined()

    // Tick again with no satisfaction: still waiting, no re-execution churn.
    const askCallsBefore = calls.ask
    const second = await engine.tick({ graph: g, state: roundTrip(first.state), executors })
    expect(second.status).toBe('waiting')
    expect(second.newWaits).toHaveLength(0)
    expect(calls.ask).toBe(askCallsBefore)

    // Satisfaction arrives (state has been through JSON round-trip twice).
    const third = await engine.tick({
      graph: g,
      state: roundTrip(second.state),
      executors,
      satisfactions: {
        ask: {
          kind: 'human-input',
          at: new Date(),
          input: {
            requestId: 'w1',
            responder: 'terry',
            channel: 'app',
            at: new Date(),
            value: 'postgres',
          },
        },
      },
    })
    expect(third.status).toBe('completed')
    expect(third.state.nodeResults.ask?.outputs.value).toBe('postgres')
    expect(calls.after).toBe(1)
  })

  it('a wait in one branch does not block an independent branch', async () => {
    const g = graph(
      [
        agent('split'),
        { id: 'pause', config: { kind: 'wait', condition: { kind: 'time', parameters: {} } } },
        agent('free'),
        agent('merge', { join: { mode: 'all' } }),
        terminal('end'),
      ],
      [
        t('s-p', 'split', 'pause'),
        t('s-f', 'split', 'free'),
        t('p-m', 'pause', 'merge'),
        t('f-m', 'free', 'merge'),
        t('m-e', 'merge', 'end'),
      ],
      'split',
    )
    const { executors, calls } = scripted({})
    const first = await run(g, executors)
    expect(first.status).toBe('waiting')
    expect(calls.free).toBe(1)
    expect(calls.merge).toBeUndefined()

    const second = await engine.tick({
      graph: g,
      state: roundTrip(first.state),
      executors,
      satisfactions: { pause: { kind: 'time', at: new Date() } },
    })
    expect(second.status).toBe('completed')
    expect(calls.merge).toBe(1)
  })
})

describe('GraphEngine effects, guards, and lifecycle', () => {
  it('applies onEnter/onExit/transition effects and collects projections', async () => {
    const events: GraphEngineEvent[] = []
    const g = graph(
      [
        agent('a', {
          onEnter: { setDomainState: 'analyzing' },
          onExit: { setData: { verdict: 'outputs.verdict' } },
        }),
        agent('b'),
        terminal('end'),
      ],
      [
        t('t1', 'a', 'b', {
          effects: { setDomainState: 'implementing', project: 'In Progress' },
        }),
        t('t2', 'b', 'end'),
      ],
      'a',
    )
    const { executors } = scripted({
      a: { type: 'result', status: 'succeeded', outputs: { verdict: 'high' } },
    })
    const outcome = await engine.tick({
      graph: g,
      state: initialRunGraphState(runId, 'snap-1'),
      executors,
      onEvent: (event) => events.push(event),
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.state.domain.name).toBe('implementing')
    expect(outcome.state.domain.data.verdict).toBe('high')
    expect(outcome.projections).toEqual(['In Progress'])
    expect(events.some((event) => event.type === 'transition.taken')).toBe(true)
    expect(
      events.filter((event) => event.type === 'domain_state.changed').map((e) => e.state),
    ).toEqual(['analyzing', 'implementing'])
  })

  it('fails nodes whose guards do not pass and can route the failure', async () => {
    const g = graph(
      [
        agent('guarded', { guards: ["domain.mode == 'allowed'"] }),
        agent('fallback'),
        terminal('end'),
      ],
      [
        t('ok', 'guarded', 'end', { condition: "node.status == 'succeeded'" }),
        t('no', 'guarded', 'fallback', { condition: "node.status == 'failed'" }),
        t('f-end', 'fallback', 'end'),
      ],
      'guarded',
    )
    const { executors, calls } = scripted({})
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.guarded).toBeUndefined() // executor never ran
    expect(outcome.state.nodeResults.guarded?.error).toContain('guard failed')
    expect(calls.fallback).toBe(1)
  })

  it('reports blocked terminals and honors cancellation', async () => {
    const g = graph([agent('a'), terminal('stuck', 'blocked')], [t('t1', 'a', 'stuck')], 'a')
    const { executors } = scripted({})
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('blocked')

    const controller = new AbortController()
    controller.abort()
    const cancelled = await engine.tick({
      graph: g,
      state: initialRunGraphState(runId, 'snap-1'),
      executors,
      signal: controller.signal,
    })
    expect(cancelled.status).toBe('cancelled')
  })

  it('enforces the settlement backstop', async () => {
    const g = graph(
      [agent('step'), terminal('end')],
      [
        t('again', 'step', 'step', { condition: "outputs.done == 'no'", loopBound: 500 }),
        t('finish', 'step', 'end', { condition: "outputs.done == 'yes'" }),
      ],
      'step',
    )
    const { executors } = scripted({
      step: { type: 'result', status: 'succeeded', outputs: { done: 'no' } },
    })
    const outcome = await engine.tick({
      graph: g,
      state: initialRunGraphState(runId, 'snap-1'),
      executors,
      maxSettlementsPerTick: 50,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('backstop')
  })
})

describe('GraphEngine implicit-join loop re-entry', () => {
  const succeeded = (outputs: Record<string, unknown>): NodeYield => ({
    type: 'result',
    status: 'succeeded',
    outputs,
  })

  it('re-enters a mid-graph loop through a different inbound edge (remediation shape)', async () => {
    const g = graph(
      [agent('review'), agent('remediate'), agent('re_review'), terminal('done')],
      [
        t('review-ok', 'review', 'done', { condition: 'outputs.approved == true' }),
        t('review-remediate', 'review', 'remediate', {
          condition: 'outputs.approved == false',
          loopBound: 2,
        }),
        t('rem-rereview', 'remediate', 're_review', {
          condition: "node.status == 'succeeded'",
          loopBound: 2,
        }),
        t('rereview-ok', 're_review', 'done', { condition: 'outputs.approved == true' }),
        t('rereview-again', 're_review', 'remediate', {
          condition: 'outputs.approved == false',
          loopBound: 1,
        }),
      ],
      'review',
    )
    const { executors, calls } = scripted({
      review: succeeded({ approved: false }),
      re_review: [succeeded({ approved: false }), succeeded({ approved: true })],
    })
    const outcome = await run(g, executors)
    // The second remediation round must actually execute: remediate is
    // reached once via review-remediate and once via rereview-again — two
    // different inbound edges, one firing each.
    expect(outcome.status).toBe('completed')
    expect(calls.remediate).toBe(2)
    expect(calls.re_review).toBe(2)
  })

  it('re-activates a non-entry self-loop until its condition clears', async () => {
    const g = graph(
      [agent('a'), agent('poll'), terminal('done')],
      [
        t('a-poll', 'a', 'poll'),
        t('poll-again', 'poll', 'poll', { condition: 'outputs.more == true', loopBound: 2 }),
        t('poll-done', 'poll', 'done', { condition: 'outputs.more == false' }),
      ],
      'a',
    )
    const { executors, calls } = scripted({
      poll: [
        { type: 'result', status: 'succeeded', outputs: { more: true } },
        { type: 'result', status: 'succeeded', outputs: { more: true } },
        { type: 'result', status: 'succeeded', outputs: { more: false } },
      ],
    })
    const outcome = await run(g, executors)
    expect(outcome.status).toBe('completed')
    expect(calls.poll).toBe(3)
  })
})
