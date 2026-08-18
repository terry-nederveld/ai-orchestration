import {
  type AgentRunHandle,
  type AgentRunRequest,
  asId,
  type CheckpointStrategy,
  DefinitionKind,
  type IdGenerator,
  InMemoryEventBus,
  noopLogger,
  type PersistenceProvider,
  RunState,
  systemClock,
  type WorkflowGraph,
  type WorkItem,
} from '@overture/core'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { FakeWorkProvider, makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { WorkflowActionRegistry } from '../ports.js'
import { GraphRunCoordinator, type SpecBuilder } from './coordinator.js'

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

/** Scripted agent executor: node role → JSON summary or behavior. */
function scriptedExecutor(script: Record<string, string | (() => string)>) {
  const calls: string[] = []
  const start = async (request: AgentRunRequest): Promise<AgentRunHandle> => {
    const role = request.goal.role ?? 'unknown'
    calls.push(role)
    const entry = script[role]
    const summary = typeof entry === 'function' ? entry() : (entry ?? '{"ok": true}')
    const outcome = summary === 'HUMAN_INPUT_REQUIRED' ? 'HUMAN_INPUT_REQUIRED' : 'GOAL_COMPLETED'
    const result = {
      outcome: outcome as 'GOAL_COMPLETED',
      summary: outcome === 'HUMAN_INPUT_REQUIRED' ? 'Which database should I use?' : summary,
      usage: {
        provider: 'scripted',
        tokens: { inputTokens: 10, outputTokens: 5 },
        durationMs: 1,
        turns: 1,
        subagents: 0,
      },
    }
    return {
      sessionId: request.sessionId,
      events: () =>
        (async function* () {
          yield { type: 'agent.completed' as const, result }
        })(),
      result: async () => result,
      cancel: async () => {},
    }
  }
  return { start, calls }
}

interface Harness {
  persistence: PersistenceProvider
  work: FakeWorkProvider
  item: WorkItem
  makeCoordinator: (script?: Record<string, string | (() => string)>) => GraphRunCoordinator
  specGoal: { value: string }
  checkpointCalls: string[]
}

async function harness(
  graph: WorkflowGraph,
  extraDefinitions: Array<{
    kind: DefinitionKind
    name: string
    document: Record<string, unknown>
  }> = [],
): Promise<Harness> {
  const persistence = new InMemoryPersistenceProvider()
  await persistence.definitions.save(
    DefinitionKind.Workflow,
    graph.name,
    graph as unknown as Record<string, unknown>,
  )
  await persistence.definitions.setLifecycle(DefinitionKind.Workflow, graph.name, 'enabled')
  await persistence.definitions.save(DefinitionKind.AgentProfile, 'default-profile', {
    name: 'default-profile',
    fragment: { primary: { executor: 'scripted' } },
  })
  await persistence.definitions.setLifecycle(
    DefinitionKind.AgentProfile,
    'default-profile',
    'enabled',
  )
  for (const definition of extraDefinitions) {
    await persistence.definitions.save(definition.kind, definition.name, definition.document)
    await persistence.definitions.setLifecycle(definition.kind, definition.name, 'enabled')
  }

  const item = makeWorkItem({
    externalId: 'ISSUE-1',
    title: 'Add export feature',
    description: 'Users need CSV export.',
    state: 'Ready',
  })
  const work = new FakeWorkProvider([item])
  const specGoal = { value: 'Add export feature' }
  const checkpointCalls: string[] = []

  const specBuilder: SpecBuilder = {
    build: async (input) => ({
      runId: input.runId,
      revision: input.revision,
      createdAt: new Date(),
      reason: input.reason,
      goal: specGoal.value,
      acceptanceCriteria: [],
      workItemId: String(input.item.id),
      relatedWorkItemIds: [],
      repositories: [],
      instructions: [],
      promotedContext: [],
      snapshotId: input.snapshotId,
      completionCriteria: [],
      metadata: {},
    }),
  }

  const checkpointStrategy: CheckpointStrategy = {
    id: 'fake-strategy',
    checkpoint: async (context) => {
      checkpointCalls.push(context.summary)
      return {
        id: `cp-${checkpointCalls.length}`,
        runId: context.runId,
        nodeId: context.nodeId,
        strategy: 'fake-strategy',
        createdAt: new Date(),
        coordinates: { marker: checkpointCalls.length },
        summary: context.summary,
        specRevision: context.specRevision,
      }
    },
    restore: async () => ({}),
  }

  const makeCoordinator = (script: Record<string, string | (() => string)> = {}) => {
    const { start } = scriptedExecutor(script)
    return new GraphRunCoordinator({
      persistence,
      work: { resolve: () => work },
      workspaces: { resolve: () => undefined },
      executors: { get: (id) => (id === 'scripted' ? start : undefined) },
      commands: { run: async () => ({ exitCode: 0, output: '' }) },
      actions: new WorkflowActionRegistry(),
      specBuilder,
      checkpoints: { select: () => checkpointStrategy },
      events: new InMemoryEventBus(),
      clock: systemClock,
      ids: new SequentialIds(),
      logger: noopLogger,
      claimant: 'test',
    })
  }
  return { persistence, work, item, makeCoordinator, specGoal, checkpointCalls }
}

const askGraph: WorkflowGraph = {
  name: 'ask-flow',
  entry: 'analyze',
  defaultProfile: { name: 'default-profile' },
  nodes: [
    { id: 'analyze', config: { kind: 'agent', goal: 'Analyze the work item' } },
    {
      id: 'ask',
      config: {
        kind: 'human-input',
        request: {
          type: 'single-choice',
          prompt: 'Pick a database',
          surface: 'both',
          choices: ['postgres', 'sqlite'],
        },
      },
    },
    { id: 'implement', config: { kind: 'agent', goal: 'Implement using the chosen database' } },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
  ],
  transitions: [
    { id: 't1', from: 'analyze', to: 'ask' },
    { id: 't2', from: 'ask', to: 'implement' },
    { id: 't3', from: 'implement', to: 'done' },
  ],
}

describe('GraphRunCoordinator durable suspension', () => {
  it('suspends on human input, checkpoints, and survives a coordinator restart', async () => {
    const h = await harness(askGraph)
    const runId = asId<'run'>('run-A')

    const first = h.makeCoordinator({ analyze: '{"assessed": true}' })
    const run = await first.start(h.item, 'ask-flow', runId)
    expect(run.state).toBe(RunState.WaitingForHuman)
    expect(h.checkpointCalls.length).toBeGreaterThan(0)

    const open = await h.persistence.waits.listOpen({ runId })
    expect(open).toHaveLength(1)
    expect(open[0]?.request?.type).toBe('single-choice')

    // "Kill the daemon": a brand-new coordinator with only persisted state.
    const second = h.makeCoordinator({ implement: '{"implemented": true}' })
    const result = await second.satisfy(open[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: 'postgres',
    })
    expect(result.accepted).toBe(true)

    const finished = await h.persistence.runs.get(runId)
    expect(finished?.state).toBe(RunState.Completed)
    const state = await h.persistence.runGraphs.get(runId)
    expect(state?.nodeResults.ask?.outputs.value).toBe('postgres')
  })

  it('rejects invalid typed input and applies first-response-wins', async () => {
    const h = await harness(askGraph)
    const runId = asId<'run'>('run-B')
    const coordinator = h.makeCoordinator({})
    await coordinator.start(h.item, 'ask-flow', runId)
    const open = await h.persistence.waits.listOpen({ runId })
    const waitId = open[0]?.id ?? ''

    const invalid = await coordinator.satisfy(waitId, {
      responder: 'terry',
      channel: 'app',
      value: 'mysql', // not among choices
    })
    expect(invalid.accepted).toBe(false)
    expect(invalid.reason).toContain('one of')

    const win = await coordinator.satisfy(waitId, {
      responder: 'terry',
      channel: 'app',
      value: 'postgres',
    })
    expect(win.accepted).toBe(true)

    const late = await coordinator.satisfy(waitId, {
      responder: 'alex',
      channel: 'work_item',
      value: 'sqlite',
    })
    expect(late.accepted).toBe(false)
    expect(late.reason).toContain('supplemental')
    const supplemental = await h.persistence.waits.listSupplemental(runId)
    expect(supplemental).toHaveLength(1)
    expect(supplemental[0]?.input.responder).toBe('alex')
  })

  it('creates a spec revision when authoritative context changed during the wait', async () => {
    const h = await harness(askGraph)
    const runId = asId<'run'>('run-C')
    const coordinator = h.makeCoordinator({})
    await coordinator.start(h.item, 'ask-flow', runId)
    const open = await h.persistence.waits.listOpen({ runId })

    // The goal changes while the run waits (e.g. the issue was edited).
    h.specGoal.value = 'Add export feature with filters'
    await coordinator.satisfy(open[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: 'sqlite',
    })

    const revisions = await h.persistence.specs.listRevisions(runId)
    expect(revisions).toHaveLength(2)
    expect(revisions[1]?.goal).toContain('filters')
    expect(revisions[1]?.reason).toBe('resume-reconciliation')
    expect(revisions[0]?.goal).toBe('Add export feature') // history preserved
  })

  it('agent ambiguity becomes a durable free-form question and resumes with the answer', async () => {
    const ambiguous: WorkflowGraph = {
      name: 'ambiguous-flow',
      entry: 'implement',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        { id: 'implement', config: { kind: 'agent', goal: 'Implement' } },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
      ],
      transitions: [{ id: 't1', from: 'implement', to: 'done' }],
    }
    const h = await harness(ambiguous)
    const runId = asId<'run'>('run-D')

    let asked = false
    const coordinator = h.makeCoordinator({
      implement: () => {
        if (!asked) {
          asked = true
          return 'HUMAN_INPUT_REQUIRED'
        }
        return '{"done": true}'
      },
    })
    const run = await coordinator.start(h.item, 'ambiguous-flow', runId)
    expect(run.state).toBe(RunState.WaitingForHuman)
    const open = await h.persistence.waits.listOpen({ runId })
    expect(open[0]?.request?.type).toBe('free-form')
    expect(open[0]?.request?.prompt).toContain('database')

    await coordinator.satisfy(open[0]?.id ?? '', {
      responder: 'terry',
      channel: 'work_item',
      value: 'Use the existing postgres cluster.',
    })
    expect((await h.persistence.runs.get(runId))?.state).toBe(RunState.Completed)
  })

  it('time waits fire through the durable timer scan', async () => {
    const timed: WorkflowGraph = {
      name: 'timed-flow',
      entry: 'pause',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        {
          id: 'pause',
          config: { kind: 'wait', condition: { kind: 'time', parameters: { afterMs: 60_000 } } },
        },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
      ],
      transitions: [{ id: 't1', from: 'pause', to: 'done' }],
    }
    const h = await harness(timed)
    const runId = asId<'run'>('run-E')
    const coordinator = h.makeCoordinator({})
    const run = await coordinator.start(h.item, 'timed-flow', runId)
    expect(run.state).toBe(RunState.Waiting)

    // Not yet due.
    expect(await coordinator.fireDueTimers(new Date())).toBe(0)
    // Due one minute later.
    const fired = await coordinator.fireDueTimers(new Date(Date.now() + 120_000))
    expect(fired).toBe(1)
    expect((await h.persistence.runs.get(runId))?.state).toBe(RunState.Completed)
  })

  it('cancels a waiting run durably', async () => {
    const h = await harness(askGraph)
    const runId = asId<'run'>('run-F')
    const coordinator = h.makeCoordinator({})
    await coordinator.start(h.item, 'ask-flow', runId)

    expect(await coordinator.cancel(runId, 'operator cancelled')).toBe(true)
    expect((await h.persistence.runs.get(runId))?.state).toBe(RunState.Cancelled)
    expect(await h.persistence.waits.listOpen({ runId })).toHaveLength(0)
  })

  it('drives structured outputs through declared transitions', async () => {
    const branching: WorkflowGraph = {
      name: 'branching-flow',
      entry: 'triage',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        {
          id: 'triage',
          config: {
            kind: 'agent',
            goal: 'Assess',
            outputSchema: {
              type: 'object',
              properties: { security_review_required: { type: 'boolean' } },
            },
          },
        },
        { id: 'security', config: { kind: 'agent', goal: 'Security review' } },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
      ],
      transitions: [
        {
          id: 'sec',
          from: 'triage',
          to: 'security',
          condition: 'outputs.security_review_required == true',
        },
        {
          id: 'skip',
          from: 'triage',
          to: 'done',
          condition: 'outputs.security_review_required == false',
        },
        { id: 's-done', from: 'security', to: 'done' },
      ],
    }
    const h = await harness(branching)
    const coordinator = h.makeCoordinator({
      triage: '{"security_review_required": true}',
      security: '{"reviewed": true}',
    })
    const run = await coordinator.start(h.item, 'branching-flow', asId<'run'>('run-G'))
    expect(run.state).toBe(RunState.Completed)
    const state = await h.persistence.runGraphs.get(asId<'run'>('run-G'))
    expect(state?.nodeResults.security?.status).toBe('succeeded')
  })

  it('runs sub-workflows as child runs and joins on completion', async () => {
    const child: WorkflowGraph = {
      name: 'child-flow',
      entry: 'work',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        { id: 'work', config: { kind: 'agent', goal: 'Child work' } },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
      ],
      transitions: [{ id: 't1', from: 'work', to: 'done' }],
    }
    const parent: WorkflowGraph = {
      name: 'parent-flow',
      entry: 'delegate',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        { id: 'delegate', config: { kind: 'subworkflow', workflow: { name: 'child-flow' } } },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
      ],
      transitions: [{ id: 't1', from: 'delegate', to: 'done' }],
    }
    const h = await harness(parent, [
      {
        kind: DefinitionKind.Workflow,
        name: 'child-flow',
        document: child as unknown as Record<string, unknown>,
      },
    ])
    const coordinator = h.makeCoordinator({ work: '{"child": true}' })
    const runId = asId<'run'>('run-H')
    await coordinator.start(h.item, 'parent-flow', runId)

    // Child runs detached; wait for the parent to complete.
    const deadline = Date.now() + 5_000
    let parentRun = await h.persistence.runs.get(runId)
    while (parentRun?.state !== RunState.Completed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      parentRun = await h.persistence.runs.get(runId)
    }
    expect(parentRun?.state).toBe(RunState.Completed)
    const childRun = await h.persistence.runs.get(asId<'run'>('run-H#delegate#main'))
    expect(childRun?.state).toBe(RunState.Completed)
  })

  it('human gates suspend on approval and honor the decision', async () => {
    const gated: WorkflowGraph = {
      name: 'gated-flow',
      entry: 'gate',
      defaultProfile: { name: 'default-profile' },
      nodes: [
        { id: 'gate', config: { kind: 'gate', gateSet: { name: 'dor' } } },
        { id: 'work', config: { kind: 'agent', goal: 'Do it' } },
        { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
        { id: 'rejected', config: { kind: 'terminal', outcome: 'blocked' } },
      ],
      transitions: [
        { id: 'ok', from: 'gate', to: 'work', condition: "node.status == 'succeeded'" },
        { id: 'no', from: 'gate', to: 'rejected', condition: "node.status == 'failed'" },
        { id: 'w-done', from: 'work', to: 'done' },
      ],
    }
    const h = await harness(gated, [
      {
        kind: DefinitionKind.GateSet,
        name: 'dor',
        document: {
          name: 'dor',
          gates: [
            {
              id: 'human-ok',
              description: 'Human confirms readiness',
              kind: 'human',
              check: 'Is this item ready for autonomous work?',
              required: true,
            },
          ],
        },
      },
    ])
    const coordinator = h.makeCoordinator({})
    const runId = asId<'run'>('run-I')
    const run = await coordinator.start(h.item, 'gated-flow', runId)
    expect(run.state).toBe(RunState.WaitingForHuman)
    const open = await h.persistence.waits.listOpen({ runId })
    expect(open[0]?.kind).toBe('approval')

    await coordinator.satisfy(open[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: true,
    })
    expect((await h.persistence.runs.get(runId))?.state).toBe(RunState.Completed)
  })
})
