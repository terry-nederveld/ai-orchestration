import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentOutcome,
  type AgentRunHandle,
  type AgentRunRequest,
  type ApprovalGateway,
  asId,
  type IdGenerator,
  InMemoryEventBus,
  noopLogger,
  type OrchestratorEvent,
  RunState,
  systemClock,
  type WorkflowDefinition,
} from '@overture/core'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import {
  FakeSourceControlProvider,
  FakeWorkProvider,
  FakeWorkspaceProvider,
  makeWorkItem,
} from '@overture/testkit'
import { InMemoryWorkflowProvider, parseWorkflowYaml } from '@overture/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinActionFactory } from './actions.js'
import { evaluateEligibility } from './eligibility.js'
import type { AgentRouter, ResolvedAgentExecutor } from './ports.js'
import { WorkflowActionRegistry } from './ports.js'
import { RunCoordinator } from './run-coordinator.js'
import { Scheduler } from './scheduler.js'

const WORKFLOW_YAML = `
name: test-flow
trigger:
  states: [Ready]
eligibility:
  labels:
    include: [agent-ready]
    exclude: [blocked]
workspace:
  strategy: fake
  retention: never
steps:
  - id: plan
    agent: planner
    goal: Analyze the work item
  - id: implement
    agent: coder
    depends_on: [plan]
    goal: Implement it
  - id: test
    command: 'true'
    depends_on: [implement]
  - id: deliver
    action: source_control.pull_request
    depends_on: [test]
transitions:
  success: Done
  failure: Agent Failed
`

class SequentialIds implements IdGenerator {
  private counter = 0
  next(prefix: string): string {
    this.counter += 1
    return `${prefix}-${this.counter}`
  }
}

/** Agent router whose executors immediately complete with scripted outcomes. */
class ScriptedAgentRouter implements AgentRouter {
  readonly requests: AgentRunRequest[] = []
  constructor(private readonly outcomes: Record<string, AgentOutcome> = {}) {}

  async resolve(step: { agent: string }): Promise<ResolvedAgentExecutor> {
    return {
      providerId: 'scripted',
      model: 'scripted-model',
      start: async (request) => {
        this.requests.push(request)
        const outcome = this.outcomes[step.agent] ?? 'GOAL_COMPLETED'
        return makeHandle(request, outcome, `${step.agent} report`)
      },
    }
  }
}

function makeHandle(
  request: AgentRunRequest,
  outcome: AgentOutcome,
  summary: string,
): AgentRunHandle {
  const result = {
    outcome,
    summary,
    usage: {
      provider: 'scripted',
      model: 'scripted-model',
      tokens: { inputTokens: 100, outputTokens: 40 },
      durationMs: 5,
      turns: 2,
      subagents: 0,
    },
  }
  return {
    sessionId: request.sessionId,
    events: () =>
      (async function* () {
        yield { type: 'agent.started' as const, sessionId: request.sessionId }
        yield { type: 'agent.completed' as const, result }
      })(),
    result: async () => result,
    cancel: async () => {},
  }
}

const approveAll: ApprovalGateway = { requestApproval: async () => true }

let baseDir: string

describe('RunCoordinator', () => {
  let work: FakeWorkProvider
  let scm: FakeSourceControlProvider
  let workspaces: FakeWorkspaceProvider
  let persistence: InMemoryPersistenceProvider
  let events: OrchestratorEvent[]
  let bus: InMemoryEventBus
  let definition: WorkflowDefinition

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'overture-orch-'))
    work = new FakeWorkProvider([
      makeWorkItem({
        externalId: 'ISSUE-7',
        title: 'Fix the widget',
        state: 'Ready',
        labels: ['agent-ready'],
        repository: { locator: 'example/repo', defaultBranch: 'main' },
      }),
    ])
    scm = new FakeSourceControlProvider()
    workspaces = new FakeWorkspaceProvider(baseDir, { strategy: 'fake' as never })
    persistence = new InMemoryPersistenceProvider()
    events = []
    bus = new InMemoryEventBus()
    bus.subscribe({}, (event) => events.push(event))
    definition = parseWorkflowYaml(WORKFLOW_YAML)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  function coordinator(agents: AgentRouter = new ScriptedAgentRouter()) {
    const actions = new WorkflowActionRegistry()
    actions.register(builtinActionFactory)
    return new RunCoordinator({
      work: { resolve: () => work },
      workspaces: { resolve: (strategy) => (strategy === 'fake' ? workspaces : undefined) },
      agents,
      commands: {
        run: async () => ({ exitCode: 0, output: 'ok' }),
      },
      actions,
      approvals: approveAll,
      persistence,
      events: bus,
      clock: systemClock,
      ids: new SequentialIds(),
      logger: noopLogger,
      scm,
      claimant: 'test-orchestrator',
    })
  }

  it('runs a work item through the full workflow to completion', async () => {
    const [item] = await work.discover({})
    if (!item) throw new Error('no seeded item')
    const runId = asId<'run'>('run-100')
    await persistence.claims.tryClaim(item.id, runId)

    const run = await coordinator().execute(item, definition, runId)

    expect(run.state).toBe(RunState.Completed)
    expect(run.history.map((h) => h.to)).toEqual([
      RunState.Preparing,
      RunState.Running,
      RunState.Completed,
    ])

    // Pull request was pushed and created off the run branch.
    const prCalls = scm.calls.filter((call) => call.op === 'createPullRequest')
    expect(prCalls).toHaveLength(1)
    expect(
      prCalls[0] && 'request' in prCalls[0] ? prCalls[0].request.sourceBranch : undefined,
    ).toBe('overture/issue-7')

    // Work item transitioned per workflow transitions.
    const updated = await work.get(item.externalId)
    expect(updated.state).toBe('Done')

    // Usage aggregated from both agent steps.
    const persisted = await persistence.runs.get(runId)
    expect(persisted?.usage?.tokens.inputTokens).toBe(200)
    expect(persisted?.usage?.turns).toBe(4)

    // Claim released after terminal state.
    expect(await persistence.claims.activeClaim(item.id)).toBeUndefined()

    // Event trail covers lifecycle.
    const types = events.map((event) => event.type)
    expect(types).toContain('run.state.changed')
    expect(types).toContain('workflow.step.started')
    expect(types).toContain('delivery.pull_request.created')
    expect(types).toContain('workflow.transitioned')
  })

  it('fails the run and transitions the work item on agent failure', async () => {
    const [item] = await work.discover({})
    if (!item) throw new Error('no seeded item')
    const runId = asId<'run'>('run-101')
    await persistence.claims.tryClaim(item.id, runId)

    const run = await coordinator(new ScriptedAgentRouter({ coder: 'GOAL_BLOCKED' })).execute(
      item,
      definition,
      runId,
    )

    expect(run.state).toBe(RunState.Failed)
    const updated = await work.get(item.externalId)
    expect(updated.state).toBe('Agent Failed')
    expect(scm.calls.filter((call) => call.op === 'createPullRequest')).toHaveLength(0)
    expect(await persistence.claims.activeClaim(item.id)).toBeUndefined()
  })

  it('cancels an in-flight run', async () => {
    const [item] = await work.discover({})
    if (!item) throw new Error('no seeded item')
    const runId = asId<'run'>('run-102')
    await persistence.claims.tryClaim(item.id, runId)

    const slowRouter: AgentRouter = {
      resolve: async () => ({
        providerId: 'slow',
        start: async (request) => ({
          sessionId: request.sessionId,
          events: () => (async function* () {})(),
          result: () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    outcome: 'CANCELLED',
                    summary: 'cancelled',
                    usage: {
                      provider: 'slow',
                      tokens: { inputTokens: 0, outputTokens: 0 },
                      durationMs: 0,
                      turns: 0,
                      subagents: 0,
                    },
                  }),
                5_000,
              ),
            ),
          cancel: async () => {},
        }),
      }),
    }
    const coordinatorInstance = coordinator(slowRouter)
    const pending = coordinatorInstance.execute(item, definition, runId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await coordinatorInstance.cancel(runId)).toBe(true)
    const run = await pending
    expect([RunState.Cancelled, RunState.Failed]).toContain(run.state)
  }, 10_000)
})

describe('Scheduler', () => {
  it('discovers, claims once, and executes eligible work', async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'overture-sched-'))
    const work = new FakeWorkProvider([
      makeWorkItem({ externalId: 'ISSUE-1', state: 'Ready', labels: ['agent-ready'] }),
      makeWorkItem({ externalId: 'ISSUE-2', state: 'Backlog', labels: [] }),
    ])
    const persistence = new InMemoryPersistenceProvider()
    const bus = new InMemoryEventBus()
    const seen: OrchestratorEvent[] = []
    bus.subscribe({}, (event) => seen.push(event))
    const workspaces = new FakeWorkspaceProvider(baseDir, { strategy: 'fake' as never })
    const actions = new WorkflowActionRegistry()
    const ids = new SequentialIds()

    const yaml = `
name: minimal
trigger:
  states: [Ready]
workspace: { strategy: fake, retention: never }
steps:
  - id: solo
    agent: coder
    goal: Do it
transitions: { success: Done }
`
    const definition = parseWorkflowYaml(yaml)
    const coordinator = new RunCoordinator({
      work: { resolve: () => work },
      workspaces: { resolve: () => workspaces },
      agents: new ScriptedAgentRouter(),
      commands: { run: async () => ({ exitCode: 0, output: '' }) },
      actions,
      approvals: approveAll,
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      claimant: 'test',
    })
    const scheduler = new Scheduler({
      sources: [{ provider: work }],
      workflows: new InMemoryWorkflowProvider([definition]),
      coordinator,
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      pollIntervalMs: 60_000,
      maxConcurrentRuns: 2,
    })

    await scheduler.start()
    // Second tick while first may still be running must not double-claim.
    await scheduler.tick()
    await scheduler.stop()

    const runs = await persistence.runs.list()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe(RunState.Completed)
    const claimEvents = seen.filter((event) => event.type === 'work.claimed')
    expect(claimEvents).toHaveLength(1)
    await rm(baseDir, { recursive: true, force: true })
  })

  it('recovers interrupted runs on start', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const item = makeWorkItem({ externalId: 'ISSUE-9', state: 'Ready' })
    const runId = asId<'run'>('run-interrupted')
    await persistence.claims.tryClaim(item.id, runId)
    await persistence.runs.save({
      id: runId,
      workItemId: item.id,
      workflowName: 'minimal',
      state: RunState.Running,
      sessionIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      history: [],
    })

    const bus = new InMemoryEventBus()
    const scheduler = new Scheduler({
      sources: [],
      workflows: new InMemoryWorkflowProvider([]),
      coordinator: new RunCoordinator({
        work: { resolve: () => undefined },
        workspaces: { resolve: () => undefined },
        agents: new ScriptedAgentRouter(),
        commands: { run: async () => ({ exitCode: 0, output: '' }) },
        actions: new WorkflowActionRegistry(),
        approvals: approveAll,
        persistence,
        events: bus,
        clock: systemClock,
        ids: new SequentialIds(),
        logger: noopLogger,
        claimant: 'test',
      }),
      persistence,
      events: bus,
      clock: systemClock,
      ids: new SequentialIds(),
      logger: noopLogger,
      pollIntervalMs: 60_000,
    })
    await scheduler.start()
    await scheduler.stop()

    const recovered = await persistence.runs.get(runId)
    expect(recovered?.state).toBe(RunState.Failed)
    expect(recovered?.error).toContain('interrupted')
    expect(await persistence.claims.activeClaim(item.id)).toBeUndefined()
  })
})

describe('eligibility', () => {
  const definition = parseWorkflowYaml(WORKFLOW_YAML)

  it('accepts items matching trigger and labels', () => {
    const item = makeWorkItem({ state: 'Ready', labels: ['agent-ready'] })
    expect(evaluateEligibility(item, definition).eligible).toBe(true)
  })

  it('rejects wrong state, missing label, and excluded label', () => {
    expect(
      evaluateEligibility(makeWorkItem({ state: 'Backlog', labels: ['agent-ready'] }), definition)
        .eligible,
    ).toBe(false)
    expect(
      evaluateEligibility(makeWorkItem({ state: 'Ready', labels: [] }), definition).eligible,
    ).toBe(false)
    expect(
      evaluateEligibility(
        makeWorkItem({ state: 'Ready', labels: ['agent-ready', 'blocked'] }),
        definition,
      ).eligible,
    ).toBe(false)
  })
})
