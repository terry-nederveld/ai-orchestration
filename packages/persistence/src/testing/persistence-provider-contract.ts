/**
 * Behavioral contract exercised against every `PersistenceProvider`
 * implementation in this package — SQLite backed by a temp file, SQLite
 * backed by ':memory:', and the pure in-memory adapter — so the adapters
 * can't silently drift from each other. Not a `*.test.ts` file itself: it's
 * imported by one.
 */

import {
  asId,
  type Checkpoint,
  DefinitionKind,
  type ExecutionSpecification,
  type ExperimentRecord,
  type GraphNodeResult,
  type JudgmentOutcome,
  type Message,
  type PersistenceProvider,
  type ResolvedSnapshot,
  type Run,
  type RunGraphState,
  RunState,
  type SessionSnapshot,
  type UsageRecord,
  type WaitCondition,
  type WaitSatisfaction,
} from '@overture/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const runId = (n: number) => asId<'run'>(`run-${n}`)
const workItemId = (n: number) => asId<'work-item'>(`work-${n}`)
const sessionId = (n: number) => asId<'session'>(`session-${n}`)
const eventId = (n: number) => asId<'event'>(`event-${n}`)

function makeRun(overrides: Partial<Run> = {}): Run {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: runId(1),
    workItemId: workItemId(1),
    workflowName: 'issue-to-pr',
    state: RunState.Queued,
    sessionIds: [],
    createdAt,
    updatedAt: createdAt,
    history: [],
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const messages: readonly Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ]
  return {
    sessionId: sessionId(1),
    runId: runId(1),
    provider: 'anthropic',
    messages,
    updatedAt: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  }
}

const usage = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: 'anthropic',
  model: 'claude',
  tokens: { inputTokens: 100, outputTokens: 50 },
  durationMs: 1_000,
  turns: 1,
  subagents: 0,
  ...overrides,
})

function makeWait(overrides: Partial<WaitCondition> = {}): WaitCondition {
  return {
    id: 'wait-1',
    runId: runId(1),
    nodeId: 'node-1',
    kind: 'human-input',
    parameters: { question: 'proceed?' },
    status: 'open',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

const satisfaction = (overrides: Partial<WaitSatisfaction> = {}): WaitSatisfaction => ({
  kind: 'human-input',
  at: new Date('2026-01-01T01:00:00.000Z'),
  input: {
    requestId: 'wait-1',
    responder: 'terry',
    channel: 'app',
    at: new Date('2026-01-01T01:00:00.000Z'),
    value: 'yes, proceed',
  },
  ...overrides,
})

function makeGraphNodeResult(overrides: Partial<GraphNodeResult> = {}): GraphNodeResult {
  return {
    nodeId: 'node-1',
    attempt: 1,
    status: 'succeeded',
    outputs: { verdict: 'pass' },
    startedAt: new Date('2026-01-01T00:01:00.000Z'),
    settledAt: new Date('2026-01-01T00:02:00.000Z'),
    ...overrides,
  }
}

function makeGraphState(overrides: Partial<RunGraphState> = {}): RunGraphState {
  const result = makeGraphNodeResult()
  return {
    runId: runId(1),
    snapshotId: 'snapshot-1',
    activeNodeIds: ['node-2'],
    nodeResults: { 'node-1': result },
    resultHistory: [result],
    loopCounters: { 'transition-1': 2 },
    domain: { name: 'coding', data: { branch: 'main' } },
    fanOuts: {
      'node-3': { nodeId: 'node-3', branches: [{ key: 'branch-a', status: 'pending' }] },
    },
    variables: { attempt_budget: 3 },
    specRevision: 1,
    updatedAt: new Date('2026-01-01T00:02:00.000Z'),
    ...overrides,
  }
}

function makeSpec(overrides: Partial<ExecutionSpecification> = {}): ExecutionSpecification {
  return {
    runId: runId(1),
    revision: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    reason: 'initial',
    goal: 'implement the feature',
    acceptanceCriteria: ['tests pass'],
    workItemId: 'work-1',
    relatedWorkItemIds: [],
    repositories: [],
    instructions: [],
    promotedContext: [],
    snapshotId: 'snapshot-1',
    completionCriteria: ['PR opened'],
    metadata: {},
    ...overrides,
  }
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'checkpoint-1',
    runId: runId(1),
    nodeId: 'node-1',
    strategy: 'git-branch',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    coordinates: { branch: 'overture/run-1', sha: 'abc123' },
    summary: 'first slice implemented',
    specRevision: 1,
    ...overrides,
  }
}

function makeExperiment(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    id: 'experiment-1',
    runId: runId(1),
    nodeId: 'node-1',
    experimentName: 'cache-strategy',
    experimentVersion: 1,
    rubricName: 'latency-rubric',
    rubricVersion: 1,
    hypothesis: 'a write-through cache halves p99',
    iteration: 1,
    candidates: [
      {
        id: 'candidate-1',
        iteration: 1,
        title: 'write-through',
        summary: 'cache on write',
        status: 'evaluated',
        artifacts: { branch: 'experiment/write-through' },
        evidence: ['bench: p99 42ms'],
        scores: [{ criterionId: 'latency', score: 8, reason: 'meets target' }],
        weightedScore: 8,
      },
    ],
    lessons: ['warm-up dominates the first run'],
    status: 'running',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  }
}

const judgment = (at: string, overrides: Partial<JudgmentOutcome> = {}): JudgmentOutcome => ({
  experimentId: 'experiment-1',
  decision: 'advance',
  decidedBy: 'terry',
  at: new Date(at),
  ...overrides,
})

export function describePersistenceProviderContract(
  name: string,
  createProvider: () => PersistenceProvider | Promise<PersistenceProvider>,
): void {
  describe(`PersistenceProvider contract: ${name}`, () => {
    let provider: PersistenceProvider

    beforeEach(async () => {
      provider = await createProvider()
      await provider.migrate()
    })

    afterEach(async () => {
      await provider.close()
    })

    it('migrate() is idempotent', async () => {
      await expect(provider.migrate()).resolves.toBeUndefined()
      await expect(provider.migrate()).resolves.toBeUndefined()
    })

    describe('runs', () => {
      it('round-trips a run including history and rehydrates Dates', async () => {
        const run = makeRun({
          currentStepId: 'step-1',
          history: [
            {
              from: RunState.Queued,
              to: RunState.Preparing,
              at: new Date('2026-01-01T00:01:00.000Z'),
            },
            {
              from: RunState.Preparing,
              to: RunState.Running,
              at: new Date('2026-01-01T00:02:00.000Z'),
              reason: 'workspace ready',
            },
          ],
          usage: usage(),
        })
        await provider.runs.save(run)

        const loaded = await provider.runs.get(run.id)
        expect(loaded).toBeDefined()
        expect(loaded?.id).toBe(run.id)
        expect(loaded?.createdAt).toBeInstanceOf(Date)
        expect(loaded?.createdAt.toISOString()).toBe(run.createdAt.toISOString())
        expect(loaded?.history).toHaveLength(2)
        expect(loaded?.history[1]?.at).toBeInstanceOf(Date)
        expect(loaded?.history[1]?.reason).toBe('workspace ready')
        expect(loaded?.usage).toEqual(run.usage)
        expect(loaded?.currentStepId).toBe('step-1')
      })

      it('returns undefined for an unknown run', async () => {
        expect(await provider.runs.get(runId(999))).toBeUndefined()
      })

      it('overwrites on repeated save of the same id', async () => {
        await provider.runs.save(makeRun({ state: RunState.Queued }))
        await provider.runs.save(makeRun({ state: RunState.Running, updatedAt: new Date() }))
        const loaded = await provider.runs.get(runId(1))
        expect(loaded?.state).toBe(RunState.Running)
      })

      it('lists runs filtered by state, work item, and limit', async () => {
        await provider.runs.save(
          makeRun({ id: runId(1), workItemId: workItemId(1), state: RunState.Queued }),
        )
        await provider.runs.save(
          makeRun({
            id: runId(2),
            workItemId: workItemId(1),
            state: RunState.Running,
            createdAt: new Date('2026-01-01T01:00:00.000Z'),
            updatedAt: new Date('2026-01-01T01:00:00.000Z'),
          }),
        )
        await provider.runs.save(
          makeRun({
            id: runId(3),
            workItemId: workItemId(2),
            state: RunState.Running,
            createdAt: new Date('2026-01-01T02:00:00.000Z'),
            updatedAt: new Date('2026-01-01T02:00:00.000Z'),
          }),
        )

        const running = await provider.runs.list({ states: [RunState.Running] })
        expect(running.map((r) => r.id).sort()).toEqual([runId(2), runId(3)].sort())

        const forWorkItem = await provider.runs.list({ workItemId: workItemId(1) })
        expect(forWorkItem.map((r) => r.id).sort()).toEqual([runId(1), runId(2)].sort())

        const limited = await provider.runs.list({ limit: 1 })
        expect(limited).toHaveLength(1)
      })
    })

    describe('sessions', () => {
      it('round-trips a session snapshot', async () => {
        const snapshot = makeSnapshot({ model: 'claude-sonnet', systemPrompt: 'be helpful' })
        await provider.sessions.save(snapshot)

        const loaded = await provider.sessions.get(snapshot.sessionId)
        expect(loaded?.messages).toEqual(snapshot.messages)
        expect(loaded?.updatedAt).toBeInstanceOf(Date)
        expect(loaded?.updatedAt.toISOString()).toBe(snapshot.updatedAt.toISOString())
        expect(loaded?.model).toBe('claude-sonnet')
        expect(loaded?.systemPrompt).toBe('be helpful')
      })

      it('lists sessions for a run', async () => {
        await provider.sessions.save(makeSnapshot({ sessionId: sessionId(1), runId: runId(1) }))
        await provider.sessions.save(
          makeSnapshot({
            sessionId: sessionId(2),
            runId: runId(1),
            updatedAt: new Date('2026-01-01T00:10:00.000Z'),
          }),
        )
        await provider.sessions.save(makeSnapshot({ sessionId: sessionId(3), runId: runId(2) }))

        const forRun1 = await provider.sessions.listForRun(runId(1))
        expect(forRun1.map((s) => s.sessionId).sort()).toEqual([sessionId(1), sessionId(2)].sort())
      })
    })

    describe('events', () => {
      it('appends and lists events for a run in order, honoring afterEventId', async () => {
        await provider.events.append({
          id: eventId(1),
          at: new Date('2026-01-01T00:00:00.000Z'),
          runId: runId(1),
          type: 'work.claimed',
          workItemId: workItemId(1),
        })
        await provider.events.append({
          id: eventId(2),
          at: new Date('2026-01-01T00:01:00.000Z'),
          runId: runId(1),
          type: 'run.state.changed',
          from: RunState.Queued,
          to: RunState.Preparing,
        })
        await provider.events.append({
          id: eventId(3),
          at: new Date('2026-01-01T00:02:00.000Z'),
          runId: runId(2),
          type: 'error',
          scope: 'test',
          message: 'unrelated run',
        })

        const forRun1 = await provider.events.listForRun(runId(1))
        expect(forRun1.map((e) => e.id)).toEqual([eventId(1), eventId(2)])
        expect(forRun1[0]?.at).toBeInstanceOf(Date)

        const afterFirst = await provider.events.listForRun(runId(1), eventId(1))
        expect(afterFirst.map((e) => e.id)).toEqual([eventId(2)])
      })

      it('filters list() by type and limit', async () => {
        await provider.events.append({
          id: eventId(1),
          at: new Date('2026-01-01T00:00:00.000Z'),
          type: 'error',
          scope: 'a',
          message: 'first',
        })
        await provider.events.append({
          id: eventId(2),
          at: new Date('2026-01-01T00:01:00.000Z'),
          type: 'work.discovered',
          workItemId: workItemId(1),
          provider: 'github',
        })
        await provider.events.append({
          id: eventId(3),
          at: new Date('2026-01-01T00:02:00.000Z'),
          type: 'error',
          scope: 'b',
          message: 'second',
        })

        const errors = await provider.events.list({ types: ['error'] })
        expect(errors.map((e) => e.id).sort()).toEqual([eventId(1), eventId(3)].sort())

        const limited = await provider.events.list({ limit: 1 })
        expect(limited).toHaveLength(1)
      })
    })

    describe('claims', () => {
      it('grants a claim to the first run and rejects a different run', async () => {
        expect(await provider.claims.tryClaim(workItemId(1), runId(1))).toBe(true)
        expect(await provider.claims.tryClaim(workItemId(1), runId(2))).toBe(false)
        expect(await provider.claims.activeClaim(workItemId(1))).toBe(runId(1))
      })

      it('is idempotent for a re-claim by the same run', async () => {
        expect(await provider.claims.tryClaim(workItemId(1), runId(1))).toBe(true)
        expect(await provider.claims.tryClaim(workItemId(1), runId(1))).toBe(true)
        expect(await provider.claims.activeClaim(workItemId(1))).toBe(runId(1))
      })

      it('allows re-claiming after release', async () => {
        expect(await provider.claims.tryClaim(workItemId(1), runId(1))).toBe(true)
        await provider.claims.release(workItemId(1), runId(1))
        expect(await provider.claims.activeClaim(workItemId(1))).toBeUndefined()
        expect(await provider.claims.tryClaim(workItemId(1), runId(2))).toBe(true)
        expect(await provider.claims.activeClaim(workItemId(1))).toBe(runId(2))
      })

      it('ignores a release by a run that does not hold the claim', async () => {
        expect(await provider.claims.tryClaim(workItemId(1), runId(1))).toBe(true)
        await provider.claims.release(workItemId(1), runId(2))
        expect(await provider.claims.activeClaim(workItemId(1))).toBe(runId(1))
      })

      it('reports no active claim for an unclaimed work item', async () => {
        expect(await provider.claims.activeClaim(workItemId(42))).toBeUndefined()
      })
    })

    describe('usage', () => {
      it('records usage and returns totals within a period', async () => {
        await provider.usage.record(
          runId(1),
          usage({ tokens: { inputTokens: 10, outputTokens: 5 } }),
        )
        await provider.usage.record(
          runId(2),
          usage({ tokens: { inputTokens: 20, outputTokens: 8 } }),
        )

        const all = await provider.usage.totalsForPeriod(
          new Date('2000-01-01T00:00:00.000Z'),
          new Date('2100-01-01T00:00:00.000Z'),
        )
        expect(all).toHaveLength(2)

        const none = await provider.usage.totalsForPeriod(
          new Date('1990-01-01T00:00:00.000Z'),
          new Date('1991-01-01T00:00:00.000Z'),
        )
        expect(none).toHaveLength(0)
      })
    })

    describe('config', () => {
      it('separates namespaces and round-trips values', async () => {
        await provider.config.set('workflows', 'default-model', 'claude-sonnet')
        await provider.config.set('budgets', 'default-model', 'gpt')

        expect(await provider.config.get<string>('workflows', 'default-model')).toBe(
          'claude-sonnet',
        )
        expect(await provider.config.get<string>('budgets', 'default-model')).toBe('gpt')
        expect(await provider.config.get('workflows', 'missing')).toBeUndefined()
      })

      it('lists all keys in a namespace', async () => {
        await provider.config.set('workflows', 'a', 1)
        await provider.config.set('workflows', 'b', { nested: true })
        await provider.config.set('other', 'c', 'unrelated')

        expect(await provider.config.list('workflows')).toEqual({ a: 1, b: { nested: true } })
      })

      it('deletes a key', async () => {
        await provider.config.set('workflows', 'a', 1)
        await provider.config.delete('workflows', 'a')
        expect(await provider.config.get('workflows', 'a')).toBeUndefined()
      })
    })

    describe('definitions', () => {
      it('assigns version 1 to a new definition and returns it from get()', async () => {
        const saved = await provider.definitions.save(DefinitionKind.Workflow, 'issue-to-pr', {
          nodes: ['plan', 'implement'],
        })
        expect(saved.version).toBe(1)
        expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/)
        expect(saved.createdAt).toBeInstanceOf(Date)

        const loaded = await provider.definitions.get(DefinitionKind.Workflow, 'issue-to-pr')
        expect(loaded?.version).toBe(1)
        expect(loaded?.document).toEqual({ nodes: ['plan', 'implement'] })
        expect(loaded?.createdAt).toBeInstanceOf(Date)
      })

      it('dedups an unchanged document by content hash, ignoring key order', async () => {
        const first = await provider.definitions.save(DefinitionKind.Rubric, 'quality', {
          a: 1,
          b: { d: 4, c: 3 },
        })
        const second = await provider.definitions.save(DefinitionKind.Rubric, 'quality', {
          b: { c: 3, d: 4 },
          a: 1,
        })
        expect(second.version).toBe(first.version)
        expect(second.contentHash).toBe(first.contentHash)
        expect(
          await provider.definitions.listVersions(DefinitionKind.Rubric, 'quality'),
        ).toHaveLength(1)
      })

      it('mints monotonically increasing versions for changed documents', async () => {
        await provider.definitions.save(DefinitionKind.Workflow, 'issue-to-pr', { rev: 'a' })
        await provider.definitions.save(DefinitionKind.Workflow, 'issue-to-pr', { rev: 'b' })
        const third = await provider.definitions.save(DefinitionKind.Workflow, 'issue-to-pr', {
          rev: 'c',
        })
        expect(third.version).toBe(3)

        const versions = await provider.definitions.listVersions(
          DefinitionKind.Workflow,
          'issue-to-pr',
        )
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3])

        const pinned = await provider.definitions.get(DefinitionKind.Workflow, 'issue-to-pr', 2)
        expect(pinned?.document).toEqual({ rev: 'b' })
        expect(await provider.definitions.get(DefinitionKind.Workflow, 'missing')).toBeUndefined()
      })

      it('lists statuses per kind with latest version and lifecycle', async () => {
        await provider.definitions.save(DefinitionKind.Workflow, 'alpha', { rev: 'a' })
        await provider.definitions.save(DefinitionKind.Workflow, 'alpha', { rev: 'b' })
        await provider.definitions.save(DefinitionKind.Workflow, 'beta', { rev: 'a' })
        await provider.definitions.save(DefinitionKind.Rubric, 'unrelated', { rev: 'a' })
        await provider.definitions.setLifecycle(DefinitionKind.Workflow, 'alpha', 'enabled')

        const statuses = await provider.definitions.list(DefinitionKind.Workflow)
        expect(statuses).toEqual([
          { kind: DefinitionKind.Workflow, name: 'alpha', lifecycle: 'enabled', latestVersion: 2 },
          { kind: DefinitionKind.Workflow, name: 'beta', lifecycle: 'draft', latestVersion: 1 },
        ])
      })

      it('defaults lifecycle to draft and round-trips setLifecycle', async () => {
        expect(await provider.definitions.getLifecycle(DefinitionKind.Workflow, 'unknown')).toBe(
          'draft',
        )
        await provider.definitions.save(DefinitionKind.Workflow, 'alpha', { rev: 'a' })
        expect(await provider.definitions.getLifecycle(DefinitionKind.Workflow, 'alpha')).toBe(
          'draft',
        )
        await provider.definitions.setLifecycle(DefinitionKind.Workflow, 'alpha', 'disabled')
        expect(await provider.definitions.getLifecycle(DefinitionKind.Workflow, 'alpha')).toBe(
          'disabled',
        )
      })

      it('round-trips a resolved snapshot and rehydrates Dates', async () => {
        const snapshot: ResolvedSnapshot = {
          id: 'snapshot-1',
          root: { name: 'issue-to-pr', version: 2 },
          definitions: [
            {
              kind: DefinitionKind.Workflow,
              name: 'issue-to-pr',
              version: 2,
              contentHash: 'hash-a',
              document: { rev: 'b' },
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
            {
              kind: DefinitionKind.Rubric,
              name: 'quality',
              version: 1,
              contentHash: 'hash-b',
              document: { criteria: [] },
              createdAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          ],
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        }
        await provider.definitions.saveSnapshot(snapshot)

        const loaded = await provider.definitions.getSnapshot('snapshot-1')
        expect(loaded?.root).toEqual({ name: 'issue-to-pr', version: 2 })
        expect(loaded?.createdAt).toBeInstanceOf(Date)
        expect(loaded?.createdAt.toISOString()).toBe('2026-01-03T00:00:00.000Z')
        expect(loaded?.definitions).toHaveLength(2)
        expect(loaded?.definitions[1]?.createdAt).toBeInstanceOf(Date)
        expect(loaded?.definitions[1]?.createdAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
        expect(await provider.definitions.getSnapshot('missing')).toBeUndefined()
      })
    })

    describe('waits', () => {
      it('round-trips a wait condition including request and dueAt', async () => {
        await provider.waits.save(
          makeWait({
            request: { type: 'text', prompt: 'Describe the fix', surface: 'app' },
            dueAt: new Date('2026-01-02T00:00:00.000Z'),
          }),
        )

        const loaded = await provider.waits.get('wait-1')
        expect(loaded?.status).toBe('open')
        expect(loaded?.request?.prompt).toBe('Describe the fix')
        expect(loaded?.createdAt).toBeInstanceOf(Date)
        expect(loaded?.dueAt).toBeInstanceOf(Date)
        expect(loaded?.satisfaction).toBeUndefined()
        expect(await provider.waits.get('missing')).toBeUndefined()
      })

      it('satisfies an open wait once; the second attempt loses', async () => {
        await provider.waits.save(makeWait())
        expect(await provider.waits.trySatisfy('wait-1', satisfaction())).toBe(true)
        expect(await provider.waits.trySatisfy('wait-1', satisfaction())).toBe(false)

        const loaded = await provider.waits.get('wait-1')
        expect(loaded?.status).toBe('satisfied')
        expect(loaded?.satisfiedAt).toBeInstanceOf(Date)
        expect(loaded?.satisfaction?.at).toBeInstanceOf(Date)
        expect(loaded?.satisfaction?.input?.value).toBe('yes, proceed')
        expect(loaded?.satisfaction?.input?.at).toBeInstanceOf(Date)
      })

      it('lets exactly one of two concurrent satisfactions win', async () => {
        await provider.waits.save(makeWait())
        const outcomes = await Promise.all([
          provider.waits.trySatisfy('wait-1', satisfaction()),
          provider.waits.trySatisfy('wait-1', satisfaction()),
        ])
        expect(outcomes.filter(Boolean)).toHaveLength(1)
      })

      it('refuses to satisfy a non-open wait', async () => {
        await provider.waits.save(makeWait({ status: 'cancelled' }))
        expect(await provider.waits.trySatisfy('wait-1', satisfaction())).toBe(false)
        expect(await provider.waits.trySatisfy('missing', satisfaction())).toBe(false)
      })

      it('filters open waits by run, kind, and dueBefore', async () => {
        await provider.waits.save(makeWait({ id: 'wait-1', runId: runId(1), kind: 'human-input' }))
        await provider.waits.save(
          makeWait({
            id: 'wait-2',
            runId: runId(1),
            kind: 'time',
            dueAt: new Date('2026-01-02T00:00:00.000Z'),
          }),
        )
        await provider.waits.save(
          makeWait({
            id: 'wait-3',
            runId: runId(2),
            kind: 'time',
            dueAt: new Date('2026-01-05T00:00:00.000Z'),
          }),
        )
        await provider.waits.save(makeWait({ id: 'wait-4', runId: runId(2), status: 'satisfied' }))

        const open = await provider.waits.listOpen()
        expect(open.map((w) => w.id)).toEqual(['wait-1', 'wait-2', 'wait-3'])

        const forRun = await provider.waits.listOpen({ runId: runId(1) })
        expect(forRun.map((w) => w.id)).toEqual(['wait-1', 'wait-2'])

        const timeWaits = await provider.waits.listOpen({ kind: 'time' })
        expect(timeWaits.map((w) => w.id)).toEqual(['wait-2', 'wait-3'])

        // dueBefore excludes waits without a due time and waits due later.
        const due = await provider.waits.listOpen({
          dueBefore: new Date('2026-01-03T00:00:00.000Z'),
        })
        expect(due.map((w) => w.id)).toEqual(['wait-2'])
      })

      it('cancels open waits for a run without touching other runs', async () => {
        await provider.waits.save(makeWait({ id: 'wait-1', runId: runId(1) }))
        await provider.waits.save(makeWait({ id: 'wait-2', runId: runId(1), status: 'satisfied' }))
        await provider.waits.save(makeWait({ id: 'wait-3', runId: runId(2) }))

        await provider.waits.cancelForRun(runId(1))

        expect((await provider.waits.get('wait-1'))?.status).toBe('cancelled')
        expect((await provider.waits.get('wait-2'))?.status).toBe('satisfied')
        expect((await provider.waits.get('wait-3'))?.status).toBe('open')
      })

      it('stores supplemental inputs and marks them promoted', async () => {
        const input = {
          requestId: 'wait-1',
          responder: 'terry',
          channel: 'app' as const,
          at: new Date('2026-01-01T02:00:00.000Z'),
          value: 'also consider the docs',
        }
        await provider.waits.addSupplemental({ waitId: 'wait-1', runId: runId(1), input })
        await provider.waits.addSupplemental({
          waitId: 'wait-2',
          runId: runId(2),
          input: { ...input, requestId: 'wait-2' },
        })

        const forRun = await provider.waits.listSupplemental(runId(1))
        expect(forRun).toHaveLength(1)
        expect(forRun[0]?.input.value).toBe('also consider the docs')
        expect(forRun[0]?.input.at).toBeInstanceOf(Date)
        expect(forRun[0]?.promotedAt).toBeUndefined()

        await provider.waits.markSupplementalPromoted(
          'wait-1',
          new Date('2026-01-01T03:00:00.000Z'),
        )
        const promoted = await provider.waits.listSupplemental(runId(1))
        expect(promoted[0]?.promotedAt).toBeInstanceOf(Date)
        expect(promoted[0]?.promotedAt?.toISOString()).toBe('2026-01-01T03:00:00.000Z')
      })
    })

    describe('run graph state', () => {
      it('round-trips state and rehydrates Dates in results', async () => {
        const state = makeGraphState()
        await provider.runGraphs.save(state)

        const loaded = await provider.runGraphs.get(runId(1))
        expect(loaded?.snapshotId).toBe('snapshot-1')
        expect(loaded?.activeNodeIds).toEqual(['node-2'])
        expect(loaded?.loopCounters).toEqual({ 'transition-1': 2 })
        expect(loaded?.domain).toEqual({ name: 'coding', data: { branch: 'main' } })
        expect(loaded?.fanOuts['node-3']?.branches[0]?.key).toBe('branch-a')
        expect(loaded?.updatedAt).toBeInstanceOf(Date)
        expect(loaded?.nodeResults['node-1']?.startedAt).toBeInstanceOf(Date)
        expect(loaded?.nodeResults['node-1']?.settledAt).toBeInstanceOf(Date)
        expect(loaded?.resultHistory[0]?.settledAt).toBeInstanceOf(Date)
        expect(loaded?.resultHistory[0]?.settledAt.toISOString()).toBe('2026-01-01T00:02:00.000Z')
        expect(await provider.runGraphs.get(runId(999))).toBeUndefined()
      })

      it('overwrites on save and removes on delete', async () => {
        await provider.runGraphs.save(makeGraphState())
        await provider.runGraphs.save(makeGraphState({ specRevision: 2 }))
        expect((await provider.runGraphs.get(runId(1)))?.specRevision).toBe(2)

        await provider.runGraphs.delete(runId(1))
        expect(await provider.runGraphs.get(runId(1))).toBeUndefined()
      })
    })

    describe('execution specs', () => {
      it('round-trips revisions, returns the latest, and lists in order', async () => {
        await provider.specs.save(makeSpec({ revision: 1 }))
        await provider.specs.save(
          makeSpec({
            revision: 2,
            reason: 'resume-reconciliation',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
          }),
        )

        const first = await provider.specs.get(runId(1), 1)
        expect(first?.reason).toBe('initial')
        expect(first?.createdAt).toBeInstanceOf(Date)

        const latest = await provider.specs.latest(runId(1))
        expect(latest?.revision).toBe(2)
        expect(latest?.reason).toBe('resume-reconciliation')

        const revisions = await provider.specs.listRevisions(runId(1))
        expect(revisions.map((spec) => spec.revision)).toEqual([1, 2])
      })

      it('returns nothing for unknown runs and revisions', async () => {
        expect(await provider.specs.get(runId(999), 1)).toBeUndefined()
        expect(await provider.specs.latest(runId(999))).toBeUndefined()
        expect(await provider.specs.listRevisions(runId(999))).toEqual([])
      })
    })

    describe('checkpoints', () => {
      it('round-trips checkpoints and lists them in creation order', async () => {
        await provider.checkpoints.save(makeCheckpoint({ id: 'checkpoint-1' }))
        await provider.checkpoints.save(
          makeCheckpoint({
            id: 'checkpoint-2',
            createdAt: new Date('2026-01-01T01:00:00.000Z'),
            summary: 'second slice',
          }),
        )
        await provider.checkpoints.save(makeCheckpoint({ id: 'checkpoint-3', runId: runId(2) }))

        const forRun = await provider.checkpoints.listForRun(runId(1))
        expect(forRun.map((c) => c.id)).toEqual(['checkpoint-1', 'checkpoint-2'])
        expect(forRun[0]?.coordinates).toEqual({ branch: 'overture/run-1', sha: 'abc123' })
        expect(forRun[0]?.createdAt).toBeInstanceOf(Date)
        expect(await provider.checkpoints.listForRun(runId(999))).toEqual([])
      })

      it('latestForRun picks by created_at, breaking ties by insertion order', async () => {
        await provider.checkpoints.save(
          makeCheckpoint({ id: 'checkpoint-1', createdAt: new Date('2026-01-01T02:00:00.000Z') }),
        )
        await provider.checkpoints.save(
          makeCheckpoint({ id: 'checkpoint-2', createdAt: new Date('2026-01-01T01:00:00.000Z') }),
        )
        expect((await provider.checkpoints.latestForRun(runId(1)))?.id).toBe('checkpoint-1')

        await provider.checkpoints.save(
          makeCheckpoint({ id: 'checkpoint-3', createdAt: new Date('2026-01-01T02:00:00.000Z') }),
        )
        expect((await provider.checkpoints.latestForRun(runId(1)))?.id).toBe('checkpoint-3')
        expect(await provider.checkpoints.latestForRun(runId(999))).toBeUndefined()
      })
    })

    describe('experiments', () => {
      it('round-trips an experiment record and rehydrates Dates', async () => {
        await provider.experiments.save(makeExperiment())

        const loaded = await provider.experiments.get('experiment-1')
        expect(loaded?.hypothesis).toBe('a write-through cache halves p99')
        expect(loaded?.candidates[0]?.scores[0]?.score).toBe(8)
        expect(loaded?.createdAt).toBeInstanceOf(Date)
        expect(loaded?.updatedAt).toBeInstanceOf(Date)
        expect(await provider.experiments.get('missing')).toBeUndefined()
      })

      it('overwrites on save and lists records for a run', async () => {
        await provider.experiments.save(makeExperiment())
        await provider.experiments.save(
          makeExperiment({ status: 'concluded', conclusion: 'advanced' }),
        )
        await provider.experiments.save(makeExperiment({ id: 'experiment-2', runId: runId(2) }))

        const forRun = await provider.experiments.listForRun(runId(1))
        expect(forRun).toHaveLength(1)
        expect(forRun[0]?.status).toBe('concluded')
        expect(forRun[0]?.conclusion).toBe('advanced')
      })
    })

    describe('judgments', () => {
      it('round-trips outcomes for an experiment', async () => {
        await provider.judgments.save(
          judgment('2026-01-01T00:00:00.000Z', { decision: 'iterate', feedback: 'more evidence' }),
        )
        await provider.judgments.save(
          judgment('2026-01-02T00:00:00.000Z', { selectedCandidateId: 'candidate-1' }),
        )
        await provider.judgments.save(
          judgment('2026-01-03T00:00:00.000Z', { experimentId: 'experiment-2', decision: 'kill' }),
        )

        const forExperiment = await provider.judgments.listForExperiment('experiment-1')
        expect(forExperiment.map((o) => o.decision)).toEqual(['iterate', 'advance'])
        expect(forExperiment[0]?.feedback).toBe('more evidence')
        expect(forExperiment[0]?.at).toBeInstanceOf(Date)
        expect(forExperiment[1]?.selectedCandidateId).toBe('candidate-1')
        expect(await provider.judgments.listForExperiment('missing')).toEqual([])
      })

      it('bounds listForPeriod as [start, end)', async () => {
        await provider.judgments.save(judgment('2026-01-01T00:00:00.000Z'))
        await provider.judgments.save(judgment('2026-01-02T00:00:00.000Z'))
        await provider.judgments.save(judgment('2026-01-03T00:00:00.000Z'))

        const period = await provider.judgments.listForPeriod(
          new Date('2026-01-01T00:00:00.000Z'),
          new Date('2026-01-03T00:00:00.000Z'),
        )
        expect(period.map((o) => o.at.toISOString())).toEqual([
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
        ])
      })
    })

    describe('schedules', () => {
      it('returns the most recent firing by due time', async () => {
        await provider.schedules.recordFiring({
          scheduleName: 'nightly-triage',
          dueAt: new Date('2026-01-01T00:00:00.000Z'),
          firedAt: new Date('2026-01-01T00:00:05.000Z'),
          runId: 'run-1',
        })
        await provider.schedules.recordFiring({
          scheduleName: 'nightly-triage',
          dueAt: new Date('2026-01-02T00:00:00.000Z'),
        })
        await provider.schedules.recordFiring({
          scheduleName: 'weekly-report',
          dueAt: new Date('2026-01-03T00:00:00.000Z'),
        })

        const last = await provider.schedules.lastFiring('nightly-triage')
        expect(last?.dueAt).toBeInstanceOf(Date)
        expect(last?.dueAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
        expect(last?.firedAt).toBeUndefined()
        expect(last?.runId).toBeUndefined()

        expect(await provider.schedules.lastFiring('missing')).toBeUndefined()
      })

      it('round-trips firedAt and runId', async () => {
        await provider.schedules.recordFiring({
          scheduleName: 'nightly-triage',
          dueAt: new Date('2026-01-01T00:00:00.000Z'),
          firedAt: new Date('2026-01-01T00:00:05.000Z'),
          runId: 'run-1',
        })
        const last = await provider.schedules.lastFiring('nightly-triage')
        expect(last?.firedAt).toBeInstanceOf(Date)
        expect(last?.firedAt?.toISOString()).toBe('2026-01-01T00:00:05.000Z')
        expect(last?.runId).toBe('run-1')
      })
    })
  })
}
