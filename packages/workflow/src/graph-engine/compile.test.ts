import {
  asId,
  initialRunGraphState,
  type StepResult,
  validateGraph,
  type WorkflowDefinition,
  type WorkflowGraph,
} from '@overture/core'
import { describe, expect, it } from 'vitest'
import { interpolate } from '../expressions.js'
import { getBuiltinSoftwareDevelopmentWorkflow } from '../providers.js'
import { compileWorkflow, translateV1Expression } from './compile.js'
import { GraphEngine, type GraphNodeExecutors, type GraphTickOutcome } from './engine.js'
import { parseScopeExpression } from './scope-expr.js'

const runId = asId<'run'>('run-1')

/** Compiles and asserts the result passes core validation with zero issues. */
function compile(definition: WorkflowDefinition): WorkflowGraph {
  const graph = compileWorkflow(definition)
  expect(validateGraph(graph)).toEqual([])
  return graph
}

interface ScriptedResult {
  readonly status: 'succeeded' | 'failed'
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly error?: string
}

/**
 * Executors scripted per original v1 step id (default: succeed). Synthetic
 * `workflow.noop` nodes succeed silently and are not call-counted;
 * `workflow.assert` mirrors the real orchestrator action by interpolating
 * `with.condition` against settled results (bypassed steps read as v1
 * 'skipped') and failing unless it resolves to 'true'.
 */
function scripted(
  definition: WorkflowDefinition,
  script: Record<string, ScriptedResult> = {},
): { executors: GraphNodeExecutors; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const scriptedYield = async (nodeId: string) => {
    calls[nodeId] = (calls[nodeId] ?? 0) + 1
    const entry = script[nodeId] ?? { status: 'succeeded' as const }
    return {
      type: 'result' as const,
      status: entry.status,
      outputs: entry.outputs ?? {},
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }
  }
  const executors: GraphNodeExecutors = {
    agent: (node) => scriptedYield(node.id),
    command: (node) => scriptedYield(node.id),
    'human-input': (node) => scriptedYield(node.id),
    action: async (node, context) => {
      if (node.config.kind !== 'action') throw new Error('unexpected node config')
      if (node.config.action === 'workflow.noop') {
        return { type: 'result', status: 'succeeded', outputs: {} }
      }
      if (node.config.action === 'workflow.assert') {
        calls[node.id] = (calls[node.id] ?? 0) + 1
        const stepResults = new Map<string, StepResult>(
          definition.steps.map((step) => {
            const result = context.nodeResults[step.id]
            return [
              step.id,
              result
                ? { stepId: step.id, status: result.status, outputs: result.outputs }
                : { stepId: step.id, status: 'skipped', outputs: {} },
            ]
          }),
        )
        const ctx = { steps: stepResults, vars: context.variables }
        const condition = node.config.with?.condition
        const resolved = typeof condition === 'string' ? interpolate(condition, ctx) : 'false'
        if (resolved === 'true') return { type: 'result', status: 'succeeded', outputs: {} }
        const message = node.config.with?.message
        return {
          type: 'result',
          status: 'failed',
          error: typeof message === 'string' ? message : 'assertion failed',
        }
      }
      return scriptedYield(node.id)
    },
    terminal: async () => ({ type: 'result', status: 'succeeded', outputs: {} }),
  }
  return { executors, calls }
}

async function execute(
  graph: WorkflowGraph,
  executors: GraphNodeExecutors,
): Promise<GraphTickOutcome> {
  return new GraphEngine().tick({
    graph,
    state: initialRunGraphState(runId, 'snap-1', { ...(graph.variables ?? {}) }),
    executors,
  })
}

const command = (
  id: string,
  extra: Partial<Omit<WorkflowDefinition['steps'][number], 'id' | 'kind'>> = {},
): WorkflowDefinition['steps'][number] => ({ id, kind: 'command', command: 'noop', ...extra })

describe('translateV1Expression', () => {
  it('rewrites step references into the results scope', () => {
    expect(translateV1Expression('steps.review.failed')).toBe('results.review.failed')
    expect(translateV1Expression('steps.remediate.succeeded')).toBe('results.remediate.succeeded')
    expect(translateV1Expression("steps.x.status == 'failed'")).toBe(
      "(results.x.status == 'failed')",
    )
    expect(translateV1Expression('steps.analyze.outputs.title')).toBe(
      'results.analyze.outputs.title',
    )
  })

  it('keeps vars references and maps operators one-to-one', () => {
    expect(translateV1Expression('vars.flag')).toBe('vars.flag')
    expect(translateV1Expression('steps.review.succeeded || steps.re_review.succeeded')).toBe(
      '(results.review.succeeded || results.re_review.succeeded)',
    )
    expect(translateV1Expression("!steps.x.failed && vars.mode == 'fast'")).toBe(
      "(!results.x.failed && (vars.mode == 'fast'))",
    )
    expect(translateV1Expression('!(vars.a || vars.b)')).toBe('!(vars.a || vars.b)')
  })

  it('emits literals directly', () => {
    expect(translateV1Expression('true')).toBe('true')
    expect(translateV1Expression('false')).toBe('false')
    expect(translateV1Expression('vars.n == 3')).toBe('(vars.n == 3)')
    expect(translateV1Expression("vars.a != 'x y'")).toBe("(vars.a != 'x y')")
  })

  it("translates 'skipped' as neither-succeeded-nor-failed (bypassed nodes have no result)", () => {
    expect(translateV1Expression('steps.gate.skipped')).toBe(
      '(!results.gate.succeeded && !results.gate.failed)',
    )
  })

  it('always emits expressions the graph grammar can parse', () => {
    const sources = [
      'steps.review.failed',
      'steps.review.succeeded || steps.re_review.succeeded',
      "!steps.x.failed && vars.mode == 'fast'",
      'steps.gate.skipped',
      "steps.x.status != 'succeeded'",
      'true',
    ]
    for (const source of sources) {
      expect(() => parseScopeExpression(translateV1Expression(source))).not.toThrow()
    }
  })
})

describe('compileWorkflow structure', () => {
  it('compiles the built-in workflow to a valid graph carrying metadata', () => {
    const definition = getBuiltinSoftwareDevelopmentWorkflow()
    const graph = compile(definition)
    expect(graph.name).toBe('software-development')
    expect(graph.entry).toBe('__start')
    expect(graph.trigger).toEqual(definition.trigger)
    expect(graph.eligibility).toEqual(definition.eligibility)
  })

  it('carries retry, timeout, and agent settings onto node configs', () => {
    const graph = compile(getBuiltinSoftwareDevelopmentWorkflow())
    const test = graph.nodes.find((node) => node.id === 'test')
    expect(test?.config).toMatchObject({ kind: 'command', command: 'npm test', timeoutMs: 600_000 })
    expect(test?.retry).toEqual({ maxAttempts: 2, backoffMs: 5_000 })

    const analyze = graph.nodes.find((node) => node.id === 'analyze')
    expect(analyze?.config).toMatchObject({
      kind: 'agent',
      profile: { name: 'planner' },
      maxTurns: 20,
    })
  })

  it('leaves ${{ }} interpolation in carried fields untranslated for executors', () => {
    const graph = compile(getBuiltinSoftwareDevelopmentWorkflow())
    const deliver = graph.nodes.find((node) => node.id === 'deliver')
    expect(deliver?.config).toMatchObject({
      kind: 'action',
      action: 'source_control.pull_request',
      with: { title: '${{ steps.analyze.outputs.title }}' },
    })
  })

  it('maps approval steps to human-input nodes with an approval request', () => {
    const definition: WorkflowDefinition = {
      name: 'gated-delivery',
      steps: [
        command('build'),
        {
          id: 'sign_off',
          kind: 'approval',
          description: 'Approve the release',
          dependsOn: ['build'],
          timeoutMs: 1_000,
        },
      ],
    }
    const graph = compile(definition)
    const gate = graph.nodes.find((node) => node.id === 'sign_off')
    expect(gate?.config).toEqual({
      kind: 'human-input',
      request: {
        type: 'approval',
        prompt: 'Approve the release',
        surface: 'both',
        timeoutMs: 1_000,
      },
    })
  })

  it('synthesizes a __start entry with unconditional edges to every root', async () => {
    const definition: WorkflowDefinition = {
      name: 'multi-root',
      steps: [command('left'), command('right')],
    }
    const graph = compile(definition)
    const fromStart = graph.transitions.filter((transition) => transition.from === '__start')
    expect(fromStart.map((transition) => transition.to).sort()).toEqual(['left', 'right'])
    expect(fromStart.every((transition) => transition.condition === undefined)).toBe(true)

    const { executors, calls } = scripted(definition)
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls).toMatchObject({ left: 1, right: 1 })
  })

  it('rejects step ids that collide with the synthetic namespace', () => {
    const definition: WorkflowDefinition = { name: 'clash', steps: [command('__start')] }
    expect(() => compileWorkflow(definition)).toThrow(/synthetic '__' namespace/)
  })
})

describe('compiled built-in workflow on the real GraphEngine', () => {
  const definition = getBuiltinSoftwareDevelopmentWorkflow()
  const analyzeOutputs = { title: 'Fix the bug', plan: 'do it' }

  it('(a) completes when every step succeeds; remediation path is bypassed', async () => {
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      analyze: { status: 'succeeded', outputs: analyzeOutputs },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls).toEqual({
      analyze: 1,
      implement: 1,
      test: 1,
      review: 1,
      ensure_validated: 1,
      deliver: 1,
    })
  })

  it('(b) completes when review fails but remediation and re-review recover', async () => {
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      analyze: { status: 'succeeded', outputs: analyzeOutputs },
      review: { status: 'failed', error: 'found issues' },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls['remediate']).toBe(1)
    expect(calls['re_review']).toBe(1)
    expect(calls['ensure_validated']).toBe(1)
    expect(calls['deliver']).toBe(1)
    expect(outcome.state.nodeResults['review']?.status).toBe('failed')
  })

  it('(c) fails when review fails and remediation cannot fix it', async () => {
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      analyze: { status: 'succeeded', outputs: analyzeOutputs },
      review: { status: 'failed', error: 'found issues' },
      remediate: { status: 'failed', error: 'could not fix it' },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('ensure_validated')
    expect(calls['re_review']).toBeUndefined()
    expect(calls['ensure_validated']).toBe(1)
    expect(calls['deliver']).toBeUndefined()
    expect(outcome.state.nodeResults['ensure_validated']?.error).toBe(
      'neither review nor re-review succeeded',
    )
  })

  it('(d) fails when implement fails before review even runs', async () => {
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      analyze: { status: 'succeeded', outputs: analyzeOutputs },
      implement: { status: 'failed', error: 'could not implement the plan' },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain("'implement' failed")
    expect(calls['test']).toBeUndefined()
    expect(calls['review']).toBeUndefined()
    expect(calls['deliver']).toBeUndefined()
  })
})

describe('compiled v1 semantics', () => {
  it('continueOnFailure on a dependency lets dependents proceed', async () => {
    const definition: WorkflowDefinition = {
      name: 'continue',
      steps: [command('a', { continueOnFailure: true }), command('b', { dependsOn: ['a'] })],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      a: { status: 'failed', error: 'a broke' },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls['b']).toBe(1)
  })

  it('continueOnFailure on a terminal step keeps the run completed', async () => {
    const definition: WorkflowDefinition = {
      name: 'terminal-continue',
      steps: [command('only', { continueOnFailure: true })],
    }
    const graph = compile(definition)
    const { executors } = scripted(definition, { only: { status: 'failed', error: 'boom' } })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
  })

  it('a hard terminal failure fails the run', async () => {
    const definition: WorkflowDefinition = { name: 'single', steps: [command('only')] }
    const graph = compile(definition)
    const { executors } = scripted(definition, { only: { status: 'failed', error: 'boom' } })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('failed')
  })

  it('a hard mid-chain failure fails the run (v1 tainted skip)', async () => {
    const definition: WorkflowDefinition = {
      name: 'chain',
      steps: [command('a'), command('b', { dependsOn: ['a'] }), command('c', { dependsOn: ['b'] })],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      a: { status: 'failed', error: 'a broke' },
    })
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('failed')
    expect(calls['b']).toBeUndefined()
    expect(calls['c']).toBeUndefined()
  })

  it('a when-false skip of a terminal step is benign: the run completes', async () => {
    const definition: WorkflowDefinition = {
      name: 'benign-gate',
      variables: { flag: 'no' },
      steps: [command('a'), command('gated', { dependsOn: ['a'], when: "vars.flag == 'yes'" })],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition)
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls['gated']).toBeUndefined()
  })

  it('a benign when-false skip propagates through no-when dependents to a terminal step', async () => {
    const definition: WorkflowDefinition = {
      name: 'skip-propagation',
      variables: { flag: 'no' },
      steps: [
        command('a'),
        command('gate', { dependsOn: ['a'], when: "vars.flag == 'yes'" }),
        command('b', { dependsOn: ['gate'] }),
        command('c', { dependsOn: ['b'] }),
      ],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition)
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls['a']).toBe(1)
    expect(calls['gate']).toBeUndefined()
    expect(calls['b']).toBeUndefined()
    expect(calls['c']).toBeUndefined()
  })

  it('the same chain runs end to end when the gate condition is true', async () => {
    const definition: WorkflowDefinition = {
      name: 'skip-propagation-open',
      variables: { flag: 'yes' },
      steps: [
        command('a'),
        command('gate', { dependsOn: ['a'], when: "vars.flag == 'yes'" }),
        command('b', { dependsOn: ['gate'] }),
        command('c', { dependsOn: ['b'] }),
      ],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition)
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls).toMatchObject({ a: 1, gate: 1, b: 1, c: 1 })
  })

  it('a when-step runs even when its dependency failed, if its condition holds', async () => {
    const definition: WorkflowDefinition = {
      name: 'remediation',
      steps: [command('work'), command('fix', { dependsOn: ['work'], when: 'steps.work.failed' })],
    }
    const graph = compile(definition)
    const { executors, calls } = scripted(definition, {
      work: { status: 'failed', error: 'needs fixes' },
    })
    const outcome = await execute(graph, executors)
    // `fix` is the only terminal step (v1: `work`'s failure is consumed by
    // the when-gated remediation), so the run completes.
    expect(outcome.status).toBe('completed')
    expect(calls['fix']).toBe(1)
  })

  it('multi-dependency steps all-join and run exactly once', async () => {
    const definition: WorkflowDefinition = {
      name: 'join',
      steps: [
        command('a'),
        command('b'),
        command('c'),
        command('merge', { dependsOn: ['a', 'b', 'c'] }),
      ],
    }
    const graph = compile(definition)
    const merge = graph.nodes.find((node) => node.id === 'merge')
    expect(merge?.join).toEqual({ mode: 'all' })
    const { executors, calls } = scripted(definition)
    const outcome = await execute(graph, executors)
    expect(outcome.status).toBe('completed')
    expect(calls['merge']).toBe(1)
  })
})
