/**
 * Acceptance scenarios (mission §34–§37) driven end-to-end through the
 * durable graph coordinator with scripted executors — no model calls.
 *
 * Scenario A (Autonomous Delivery): agent ambiguity suspends the run
 * durably mid-implementation; the original coordinator is discarded (the
 * "killed session") and a brand-new instance resumes from persisted state
 * alone, finishing with a conventional commit and a pull request.
 *
 * Scenario B (Autonomous Discovery): investigation → hypothesis →
 * prototyped experiment → human judgment (again across a coordinator
 * restart) → PRD captured into the work item's managed section → approval
 * → fan-out story creation linked back to the outcome item.
 */

import type {
  AgentRunHandle,
  AgentRunRequest,
  CheckpointStrategy,
  CommitInfo,
  PersistenceProvider,
  PullRequestRequest,
  RunId,
  SourceControlProvider,
  Workspace,
  WorkspaceProvider,
} from '@overture/core'
import {
  asId,
  type IdGenerator,
  InMemoryEventBus,
  noopLogger,
  RunState,
  systemClock,
  type WorkItem,
} from '@overture/core'
import {
  builtinActionFactory,
  GraphRunCoordinator,
  profileExperimentStepperFactory,
  type SpecBuilder,
  WorkflowActionRegistry,
} from '@overture/orchestrator'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { FakeWorkProvider, makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { installTemplates } from './catalog.js'

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

/** Fan-out children run detached; poll until the run reaches the state. */
async function awaitRunState(
  persistence: PersistenceProvider,
  runId: RunId,
  state: RunState,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await persistence.runs.get(runId)
    if (run?.state === state) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const run = await persistence.runs.get(runId)
  throw new Error(`run ${String(runId)} is ${run?.state ?? 'missing'}, expected ${state}`)
}

/** Role-keyed scripted agent executor (role = node id or gate:<id> etc.). */
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
      summary:
        outcome === 'HUMAN_INPUT_REQUIRED'
          ? 'Should the export stream rows or buffer the full file?'
          : summary,
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

interface ScenarioHarness {
  persistence: PersistenceProvider
  work: FakeWorkProvider
  item: WorkItem
  commits: string[]
  pullRequests: PullRequestRequest[]
  checkpoints: string[]
  makeCoordinator: (script: Record<string, string | (() => string)>) => GraphRunCoordinator
}

async function scenarioHarness(item: WorkItem): Promise<ScenarioHarness> {
  const persistence = new InMemoryPersistenceProvider()
  await installTemplates(persistence.definitions, { enable: true })

  const work = new FakeWorkProvider([item])
  const commits: string[] = []
  const pullRequests: PullRequestRequest[] = []
  const checkpoints: string[] = []

  const scm: SourceControlProvider = {
    info: { id: 'fake-scm', name: 'Fake SCM', version: '0' },
    detect: async () => ({ available: true }),
    clone: async () => {},
    fetch: async () => {},
    createBranch: async () => {},
    status: async () => ({ clean: false, staged: [], unstaged: ['src/export.ts'], untracked: [] }),
    diff: async () => ({ files: [], additions: 0, deletions: 0 }),
    commit: async (_workdir, options): Promise<CommitInfo> => {
      commits.push(options.message)
      return { sha: `sha-${commits.length}`, message: options.message }
    },
    push: async () => {},
    createPullRequest: async (request) => {
      pullRequests.push(request)
      return { id: 'pr-1', number: 1, url: 'https://example.test/pr/1' }
    },
  }

  const workspace: Workspace = {
    id: asId('ws-1'),
    strategy: 'git-worktree',
    path: '/fake/workspace',
    repository: { locator: 'acme/app', defaultBranch: 'main' },
    branch: 'overture/story-7',
    createdAt: new Date(),
  }
  const workspaceProvider: WorkspaceProvider = {
    info: { id: 'fake-worktree', name: 'Fake worktree', version: '0' },
    strategy: 'git-worktree',
    create: async (request) => ({ ...workspace, branch: request.branch ?? workspace.branch }),
    cleanup: async () => {},
  }

  const checkpointStrategy: CheckpointStrategy = {
    id: 'git-branch',
    checkpoint: async (context) => {
      checkpoints.push(context.summary)
      return {
        id: `cp-${checkpoints.length}`,
        runId: context.runId,
        nodeId: context.nodeId,
        strategy: 'git-branch',
        createdAt: new Date(),
        coordinates: { branch: workspace.branch ?? '' },
        summary: context.summary,
        specRevision: context.specRevision,
      }
    },
    restore: async () => ({ workspacePath: workspace.path, branch: workspace.branch ?? '' }),
  }

  const specBuilder: SpecBuilder = {
    build: async (input) => ({
      runId: input.runId,
      revision: input.revision,
      createdAt: new Date(),
      reason: input.reason,
      goal: input.item.title,
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

  const actions = new WorkflowActionRegistry()
  actions.register(builtinActionFactory)

  const makeCoordinator = (script: Record<string, string | (() => string)>) => {
    const { start } = scriptedExecutor(script)
    return new GraphRunCoordinator({
      persistence,
      work: { resolve: () => work },
      workspaces: {
        resolve: (strategy) => (strategy === 'git-worktree' ? workspaceProvider : undefined),
      },
      executors: { get: () => start },
      commands: { run: async () => ({ exitCode: 0, output: 'tests passed' }) },
      actions,
      specBuilder,
      scm,
      checkpoints: { select: () => checkpointStrategy },
      experiments: profileExperimentStepperFactory({
        experiments: persistence.experiments,
        judgments: persistence.judgments,
      }),
      events: new InMemoryEventBus(),
      clock: systemClock,
      ids: new SequentialIds(),
      logger: noopLogger,
      claimant: 'scenario-test',
    })
  }

  return { persistence, work, item, commits, pullRequests, checkpoints, makeCoordinator }
}

const deliveryScript = {
  'gate:acceptance-inferable': '{"passed": true, "reason": "criteria stated in description"}',
  plan: '{"approach": "stream rows through a CSV serializer", "estimated_complexity": "small", "security_review_required": false}',
  implement: '{"summary": "implemented with tests"}',
  review: '{"approved": true, "findings": []}',
}

describe('Scenario A — Autonomous Delivery', () => {
  it('suspends durably on agent ambiguity and delivers after a coordinator restart', async () => {
    const item = makeWorkItem({
      externalId: 'STORY-7',
      title: 'Add CSV export',
      description: 'Users need CSV export.\n\n- [ ] exports all rows',
      state: 'Ready',
      labels: ['agent-ready'],
      repository: { locator: 'acme/app', defaultBranch: 'main' },
    })
    const h = await scenarioHarness(item)
    const runId = asId<'run'>('run-A') as RunId

    // The implementing agent hits genuine ambiguity: durable suspension.
    const first = h.makeCoordinator({ ...deliveryScript, implement: 'HUMAN_INPUT_REQUIRED' })
    const run = await first.start(h.item, 'autonomous-delivery', runId)
    expect(run.state).toBe(RunState.WaitingForHuman)
    expect(h.checkpoints.length).toBeGreaterThan(0)

    const open = await h.persistence.waits.listOpen({ runId })
    expect(open).toHaveLength(1)
    expect(open[0]?.request?.type).toBe('free-form')

    // Kill the session: only persisted state carries over.
    const second = h.makeCoordinator(deliveryScript)
    const result = await second.satisfy(open[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: 'Stream the rows; memory is the constraint.',
    })
    expect(result.accepted).toBe(true)

    const finished = await h.persistence.runs.get(runId)
    expect(finished?.state).toBe(RunState.Completed)

    // Conventional commit, no attribution of any kind.
    expect(h.commits).toEqual(['feat: implement the requested change'])
    expect(h.commits[0]).not.toMatch(/co-authored|generated|claude|copilot|ai\b/i)

    // Pull request opened from the run branch.
    expect(h.pullRequests).toHaveLength(1)
    expect(h.pullRequests[0]?.sourceBranch).toBe('overture/story-7')
    expect(h.pullRequests[0]?.title).toBe('Add CSV export')

    // The work item heard about the delivery.
    const comments = h.work.calls.filter((call) => call.op === 'comment')
    expect(comments.length).toBeGreaterThan(0)

    const state = await h.persistence.runGraphs.get(runId)
    expect(state?.domain.name).toBe('delivered')
  })

  it('fails the run when the definition of done cannot pass, without delivering', async () => {
    const item = makeWorkItem({
      externalId: 'STORY-8',
      title: 'Refactor parser',
      description: 'Refactor the parser module.',
      state: 'Ready',
      repository: { locator: 'acme/app' },
    })
    const h = await scenarioHarness(item)
    const runId = asId<'run'>('run-A2') as RunId

    // Review never approves: the bounded remediation loop must exhaust and
    // the run must fail without committing or opening a pull request.
    const coordinator = h.makeCoordinator({
      ...deliveryScript,
      review: '{"approved": false, "findings": ["misses edge case"]}',
      remediate: '{"summary": "attempted fix"}',
      re_review: '{"approved": false, "findings": ["still misses edge case"]}',
    })
    const run = await coordinator.start(h.item, 'autonomous-delivery', runId)
    expect(run.state).toBe(RunState.Failed)
    expect(h.commits).toHaveLength(0)
    expect(h.pullRequests).toHaveLength(0)
  })
})

const discoveryScript = {
  investigate:
    '{"pain_points": [{"description": "exports time out beyond 100k rows", "provenance": "support tickets #442, #519"}], "evidence_summary": "timeouts dominate export complaints"}',
  hypothesize:
    '{"hypothesis": "streaming the export removes the timeout ceiling", "rationale": "memory-bound buffering is the bottleneck"}',
  generator:
    '{"candidates": [{"title": "Stream CSV rows", "summary": "serialize incrementally"}, {"title": "Background job with email link", "summary": "defer heavy exports"}]}',
  prototyper:
    '{"artifacts": {"branch": "proto/stream-csv"}, "evidence": ["prototype streamed 1M rows in 40s"]}',
  evaluator:
    '{"scores": [{"criterionId": "impact", "score": 8, "reason": "removes the ceiling"}, {"criterionId": "confidence", "score": 7, "reason": "prototype evidence"}, {"criterionId": "effort", "score": 6, "reason": "moderate"}, {"criterionId": "risk", "score": 8, "reason": "additive"}], "evidence": ["support tickets confirm timeouts"], "risks": ["large-row serialization edge cases"]}',
  prd: '{"prd_markdown": "# PRD: Streaming CSV export\\n\\nStream rows to remove the timeout ceiling.", "story_candidates": [{"title": "Implement streaming CSV serializer", "description": "Serialize rows incrementally."}, {"title": "Add export progress indicator", "description": "Surface progress to the user."}]}',
}

describe('Scenario B — Autonomous Discovery', () => {
  it('runs investigation through judged experiment to PRD, approval, and linked stories', async () => {
    const item = makeWorkItem({
      externalId: 'OUTCOME-1',
      title: 'Reduce export abandonment',
      description: 'Outcome: users abandon large exports.',
      state: 'Ready',
    })
    const h = await scenarioHarness(item)
    const runId = asId<'run'>('run-B') as RunId

    const first = h.makeCoordinator(discoveryScript)
    const run = await first.start(h.item, 'autonomous-discovery', runId, {
      variables: { stop_after: 'stories' },
    })

    // The experiment reached human judgment: a durable single-choice wait.
    expect(run.state).toBe(RunState.WaitingForHuman)
    const judgmentWaits = await h.persistence.waits.listOpen({ runId })
    expect(judgmentWaits).toHaveLength(1)
    expect(judgmentWaits[0]?.request?.type).toBe('single-choice')
    expect(judgmentWaits[0]?.parameters['reason']).toBe('EXPERIMENT_JUDGMENT_REQUIRED')
    const advance = judgmentWaits[0]?.request?.choices?.find((c) => c.startsWith('advance:'))
    expect(advance).toBeDefined()

    // Judgment arrives on a new coordinator (the first session is gone).
    const second = h.makeCoordinator(discoveryScript)
    const judged = await second.satisfy(judgmentWaits[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: advance ?? '',
    })
    expect(judged.accepted).toBe(true)

    // The judgment is durable observability data, not just control flow.
    const judgments = await h.persistence.judgments.listForPeriod(
      new Date(0),
      new Date(Date.now() + 60_000),
    )
    expect(judgments).toHaveLength(1)
    expect(judgments[0]?.decision).toBe('advance')

    // PRD landed in the managed section; human content stays untouched.
    const body = await h.work.getDescription(h.item)
    expect(body).toContain('Outcome: users abandon large exports.')
    expect(body).toContain('overture:managed:begin')
    expect(body).toContain('# PRD: Streaming CSV export')

    // Approval is now waiting; approve story creation.
    const approvalWaits = await h.persistence.waits.listOpen({ runId })
    expect(approvalWaits).toHaveLength(1)
    expect(approvalWaits[0]?.request?.type).toBe('approval')
    const third = h.makeCoordinator(discoveryScript)
    const approved = await third.satisfy(approvalWaits[0]?.id ?? '', {
      responder: 'terry',
      channel: 'work_item',
      value: true,
    })
    expect(approved.accepted).toBe(true)

    // Story creation fans out into detached child runs; wait for the join.
    await awaitRunState(h.persistence, runId, RunState.Completed)
    const state = await h.persistence.runGraphs.get(runId)
    expect(state?.domain.name).toBe('concluded-advanced')

    // Two agent-ready stories, each linked back to the outcome item.
    const created = h.work.calls.filter((call) => call.op === 'createItem')
    expect(created).toHaveLength(2)
    for (const call of created) {
      if (call.op !== 'createItem') continue
      expect(call.draft.labels).toContain('agent-ready')
      expect(call.draft.relateTo).toEqual({
        kind: 'child-of',
        targetExternalId: 'OUTCOME-1',
      })
    }
    const titles = created.map((call) => (call.op === 'createItem' ? call.draft.title : ''))
    expect(titles).toContain('Implement streaming CSV serializer')
    expect(titles).toContain('Add export progress indicator')
  })

  it('a killed experiment concludes the workflow as learning, not failure', async () => {
    const item = makeWorkItem({
      externalId: 'OUTCOME-2',
      title: 'Speculative outcome',
      description: 'Outcome with weak evidence.',
      state: 'Ready',
    })
    const h = await scenarioHarness(item)
    const runId = asId<'run'>('run-B2') as RunId

    const coordinator = h.makeCoordinator(discoveryScript)
    await coordinator.start(h.item, 'autonomous-discovery', runId)
    const waits = await h.persistence.waits.listOpen({ runId })

    const killed = await coordinator.satisfy(waits[0]?.id ?? '', {
      responder: 'terry',
      channel: 'app',
      value: 'kill',
    })
    expect(killed.accepted).toBe(true)

    const finished = await h.persistence.runs.get(runId)
    expect(finished?.state).toBe(RunState.Completed)
    const state = await h.persistence.runGraphs.get(runId)
    expect(state?.domain.name).toBe('concluded-killed')
    expect(state?.nodeResults['experiment']?.outputs['conclusion']).toBe('killed')
    // The learning summary is preserved in the node outputs for projection.
    expect(String(state?.nodeResults['experiment']?.outputs['learning'])).toContain('Hypothesis')
  })
})
