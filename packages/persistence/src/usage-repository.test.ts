import { asId, type Clock, type UsageRecord } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { Database } from './database.js'
import { InMemoryPersistenceProvider } from './in-memory-persistence-provider.js'
import { migrate } from './migrations.js'
import { SqliteUsageRepository } from './usage-repository.js'

const runId = asId<'run'>('run-1')

const usage = (): UsageRecord => ({
  provider: 'anthropic',
  tokens: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
  turns: 1,
  subagents: 0,
})

/** Clock that returns a fixed, advanceable instant. */
function fakeClock(startIso: string): Clock & { advance(ms: number): void } {
  let now = new Date(startIso)
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

describe('period boundary semantics: [periodStart, periodEnd)', () => {
  it('SQLite: includes records at periodStart, excludes records at periodEnd', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = fakeClock('2026-01-01T00:00:00.000Z')
    const repo = new SqliteUsageRepository(db, clock)

    await repo.record(runId, usage()) // at periodStart
    clock.advance(1000)
    await repo.record(runId, usage()) // inside period
    clock.advance(1000)
    // now at periodEnd exactly
    const periodEnd = new Date('2026-01-01T00:00:02.000Z')
    await repo.record(runId, usage())

    const totals = await repo.totalsForPeriod(new Date('2026-01-01T00:00:00.000Z'), periodEnd)
    expect(totals).toHaveLength(2)
    db.close()
  })

  it('in-memory: includes records at periodStart, excludes records at periodEnd', async () => {
    const clock = fakeClock('2026-01-01T00:00:00.000Z')
    const provider = new InMemoryPersistenceProvider({ clock })
    await provider.migrate()

    await provider.usage.record(runId, usage())
    clock.advance(1000)
    await provider.usage.record(runId, usage())
    clock.advance(1000)
    const periodEnd = new Date('2026-01-01T00:00:02.000Z')
    await provider.usage.record(runId, usage())

    const totals = await provider.usage.totalsForPeriod(
      new Date('2026-01-01T00:00:00.000Z'),
      periodEnd,
    )
    expect(totals).toHaveLength(2)
    await provider.close()
  })
})
