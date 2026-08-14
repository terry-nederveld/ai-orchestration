/**
 * Pure in-memory `PersistenceProvider`, backed by JS `Map`s. No SQL, no
 * files — intended for fast unit tests elsewhere in the monorepo that need a
 * working persistence port without a database.
 *
 * Stored values are deep-cloned on write and read (via `structuredClone`) so
 * callers can't mutate repository state through references they hold,
 * mirroring the value semantics a real database round-trip would give.
 */

import type {
  ClaimStore,
  ConfigRepository,
  EventLogRepository,
  OrchestratorEvent,
  OrchestratorEventType,
  PersistenceProvider,
  Run,
  RunId,
  RunRepository,
  SessionId,
  SessionRepository,
  SessionSnapshot,
  UsageRecord,
  UsageRepository,
  WorkItemId,
} from '@overture/core'
import { type Clock, systemClock } from '@overture/core'

class InMemoryRunRepository implements RunRepository {
  private readonly rows = new Map<RunId, Run>()

  async save(run: Run): Promise<void> {
    this.rows.set(run.id, structuredClone(run))
  }

  async get(id: RunId): Promise<Run | undefined> {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : undefined
  }

  async list(filter?: {
    readonly states?: readonly string[]
    readonly workItemId?: WorkItemId
    readonly limit?: number
  }): Promise<readonly Run[]> {
    let result = [...this.rows.values()]
    const states = filter?.states
    if (states) result = result.filter((run) => states.includes(run.state))
    const workItemId = filter?.workItemId
    if (workItemId) result = result.filter((run) => run.workItemId === workItemId)
    result = result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const limit = filter?.limit
    if (limit !== undefined) result = result.slice(0, limit)
    return result.map((run) => structuredClone(run))
  }
}

class InMemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<SessionId, SessionSnapshot>()

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.rows.set(snapshot.sessionId, structuredClone(snapshot))
  }

  async get(id: SessionId): Promise<SessionSnapshot | undefined> {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly SessionSnapshot[]> {
    return [...this.rows.values()]
      .filter((snapshot) => snapshot.runId === runId)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .map((snapshot) => structuredClone(snapshot))
  }
}

class InMemoryEventLogRepository implements EventLogRepository {
  private readonly rows: OrchestratorEvent[] = []

  async append(event: OrchestratorEvent): Promise<void> {
    this.rows.push(structuredClone(event))
  }

  async listForRun(runId: RunId, afterEventId?: string): Promise<readonly OrchestratorEvent[]> {
    let result = this.rows.filter((event) => event.runId === runId)
    if (afterEventId) {
      const index = result.findIndex((event) => event.id === afterEventId)
      if (index >= 0) result = result.slice(index + 1)
    }
    return result.map((event) => structuredClone(event))
  }

  async list(filter?: {
    readonly types?: readonly OrchestratorEventType[]
    readonly limit?: number
  }): Promise<readonly OrchestratorEvent[]> {
    // Mirrors the SQLite adapter's `ORDER BY seq DESC` (most recent first).
    let result = [...this.rows].reverse()
    const types = filter?.types
    if (types) result = result.filter((event) => types.includes(event.type))
    const limit = filter?.limit
    if (limit !== undefined) result = result.slice(0, limit)
    return result.map((event) => structuredClone(event))
  }
}

interface StoredClaim {
  readonly runId: RunId
  readonly releasedAt?: Date
}

class InMemoryClaimStore implements ClaimStore {
  private readonly claims = new Map<WorkItemId, StoredClaim>()

  async tryClaim(workItemId: WorkItemId, runId: RunId): Promise<boolean> {
    const existing = this.claims.get(workItemId)
    if (!existing || existing.releasedAt) {
      this.claims.set(workItemId, { runId })
      return true
    }
    return existing.runId === runId
  }

  async release(workItemId: WorkItemId, runId: RunId): Promise<void> {
    const existing = this.claims.get(workItemId)
    if (existing && existing.runId === runId && !existing.releasedAt) {
      this.claims.set(workItemId, { runId, releasedAt: new Date() })
    }
  }

  async activeClaim(workItemId: WorkItemId): Promise<RunId | undefined> {
    const existing = this.claims.get(workItemId)
    return existing && !existing.releasedAt ? existing.runId : undefined
  }
}

interface StoredUsageRecord {
  readonly runId: RunId
  readonly recordedAt: Date
  readonly usage: UsageRecord
}

class InMemoryUsageRepository implements UsageRepository {
  private readonly records: StoredUsageRecord[] = []

  constructor(private readonly clock: Clock) {}

  async record(runId: RunId, usage: UsageRecord): Promise<void> {
    this.records.push({ runId, recordedAt: this.clock.now(), usage: structuredClone(usage) })
  }

  async totalsForPeriod(periodStart: Date, periodEnd: Date): Promise<readonly UsageRecord[]> {
    return this.records
      .filter((record) => record.recordedAt >= periodStart && record.recordedAt < periodEnd)
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
      .map((record) => structuredClone(record.usage))
  }
}

class InMemoryConfigRepository implements ConfigRepository {
  private readonly values = new Map<string, unknown>()

  private key(namespace: string, key: string): string {
    return `${namespace}\u0000${key}`
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const storeKey = this.key(namespace, key)
    return this.values.has(storeKey) ? (structuredClone(this.values.get(storeKey)) as T) : undefined
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    this.values.set(this.key(namespace, key), structuredClone(value))
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.values.delete(this.key(namespace, key))
  }

  async list(namespace: string): Promise<Readonly<Record<string, unknown>>> {
    const prefix = `${namespace}\u0000`
    const result: Record<string, unknown> = {}
    for (const [storeKey, value] of this.values) {
      if (storeKey.startsWith(prefix))
        result[storeKey.slice(prefix.length)] = structuredClone(value)
    }
    return result
  }
}

export interface InMemoryPersistenceProviderOptions {
  readonly clock?: Clock
}

export class InMemoryPersistenceProvider implements PersistenceProvider {
  readonly id = 'in-memory'
  readonly runs: RunRepository = new InMemoryRunRepository()
  readonly sessions: SessionRepository = new InMemorySessionRepository()
  readonly events: EventLogRepository = new InMemoryEventLogRepository()
  readonly claims: ClaimStore = new InMemoryClaimStore()
  readonly usage: UsageRepository
  readonly config: ConfigRepository = new InMemoryConfigRepository()

  constructor(options: InMemoryPersistenceProviderOptions = {}) {
    this.usage = new InMemoryUsageRepository(options.clock ?? systemClock)
  }

  async migrate(): Promise<void> {
    // No schema to migrate; the shape lives in the TypeScript types.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
