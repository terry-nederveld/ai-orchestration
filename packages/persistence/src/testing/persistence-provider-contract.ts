/**
 * Behavioral contract exercised against every `PersistenceProvider`
 * implementation in this package — SQLite backed by a temp file, SQLite
 * backed by ':memory:', and the pure in-memory adapter — so the adapters
 * can't silently drift from each other. Not a `*.test.ts` file itself: it's
 * imported by one.
 */

import {
  asId,
  type Message,
  type PersistenceProvider,
  type Run,
  RunState,
  type SessionSnapshot,
  type UsageRecord,
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
  })
}
