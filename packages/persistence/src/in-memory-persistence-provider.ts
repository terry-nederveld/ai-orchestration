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
  Checkpoint,
  CheckpointRepository,
  ClaimStore,
  ConfigRepository,
  DefinitionKind,
  DefinitionLifecycle,
  DefinitionStatus,
  DefinitionStore,
  DefinitionVersion,
  EventLogRepository,
  ExecutionSpecification,
  ExecutionSpecRepository,
  ExperimentRecord,
  ExperimentRepository,
  JudgmentOutcome,
  JudgmentRepository,
  OrchestratorEvent,
  OrchestratorEventType,
  PersistenceProvider,
  ResolvedSnapshot,
  Run,
  RunGraphState,
  RunGraphStateRepository,
  RunId,
  RunRepository,
  ScheduleFiring,
  ScheduleRepository,
  SessionId,
  SessionRepository,
  SessionSnapshot,
  SupplementalInput,
  UsageRecord,
  UsageRepository,
  WaitCondition,
  WaitKind,
  WaitRepository,
  WaitSatisfaction,
  WorkItemId,
} from '@overture/core'
import { type Clock, systemClock } from '@overture/core'
import { contentHashOf } from './definition-store.js'

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

class InMemoryDefinitionStore implements DefinitionStore {
  private readonly versions = new Map<string, DefinitionVersion[]>()
  private readonly lifecycles = new Map<string, DefinitionLifecycle>()
  private readonly snapshots = new Map<string, ResolvedSnapshot>()

  constructor(private readonly clock: Clock) {}

  private key(kind: DefinitionKind, name: string): string {
    return `${kind}\u0000${name}`
  }

  async save(
    kind: DefinitionKind,
    name: string,
    document: Readonly<Record<string, unknown>>,
  ): Promise<DefinitionVersion> {
    const contentHash = contentHashOf(document)
    const existing = this.versions.get(this.key(kind, name)) ?? []
    const latest = existing[existing.length - 1]
    if (latest && latest.contentHash === contentHash) return structuredClone(latest)
    const version: DefinitionVersion = {
      kind,
      name,
      version: (latest?.version ?? 0) + 1,
      contentHash,
      document: structuredClone(document),
      createdAt: this.clock.now(),
    }
    this.versions.set(this.key(kind, name), [...existing, version])
    return structuredClone(version)
  }

  async get(
    kind: DefinitionKind,
    name: string,
    version?: number,
  ): Promise<DefinitionVersion | undefined> {
    const versions = this.versions.get(this.key(kind, name)) ?? []
    const found =
      version !== undefined
        ? versions.find((entry) => entry.version === version)
        : versions[versions.length - 1]
    return found ? structuredClone(found) : undefined
  }

  async list(kind: DefinitionKind): Promise<readonly DefinitionStatus[]> {
    const statuses: DefinitionStatus[] = []
    for (const versions of this.versions.values()) {
      const latest = versions[versions.length - 1]
      if (!latest || latest.kind !== kind) continue
      statuses.push({
        kind,
        name: latest.name,
        lifecycle: this.lifecycles.get(this.key(kind, latest.name)) ?? 'draft',
        latestVersion: latest.version,
      })
    }
    return statuses.sort((a, b) => a.name.localeCompare(b.name))
  }

  async listVersions(kind: DefinitionKind, name: string): Promise<readonly DefinitionVersion[]> {
    return (this.versions.get(this.key(kind, name)) ?? []).map((entry) => structuredClone(entry))
  }

  async setLifecycle(
    kind: DefinitionKind,
    name: string,
    lifecycle: DefinitionLifecycle,
  ): Promise<void> {
    this.lifecycles.set(this.key(kind, name), lifecycle)
  }

  async getLifecycle(kind: DefinitionKind, name: string): Promise<DefinitionLifecycle> {
    return this.lifecycles.get(this.key(kind, name)) ?? 'draft'
  }

  async saveSnapshot(snapshot: ResolvedSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, structuredClone(snapshot))
  }

  async getSnapshot(id: string): Promise<ResolvedSnapshot | undefined> {
    const snapshot = this.snapshots.get(id)
    return snapshot ? structuredClone(snapshot) : undefined
  }
}

class InMemoryWaitRepository implements WaitRepository {
  private readonly conditions = new Map<string, WaitCondition>()
  private readonly supplementals: SupplementalInput[] = []

  async save(condition: WaitCondition): Promise<void> {
    this.conditions.set(condition.id, structuredClone(condition))
  }

  async get(id: string): Promise<WaitCondition | undefined> {
    const condition = this.conditions.get(id)
    return condition ? structuredClone(condition) : undefined
  }

  async listOpen(filter?: {
    readonly runId?: RunId
    readonly kind?: WaitKind
    readonly dueBefore?: Date
  }): Promise<readonly WaitCondition[]> {
    let result = [...this.conditions.values()].filter((condition) => condition.status === 'open')
    const runId = filter?.runId
    if (runId) result = result.filter((condition) => condition.runId === runId)
    const kind = filter?.kind
    if (kind) result = result.filter((condition) => condition.kind === kind)
    const dueBefore = filter?.dueBefore
    if (dueBefore) {
      result = result.filter(
        (condition) => condition.dueAt !== undefined && condition.dueAt < dueBefore,
      )
    }
    return result
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((condition) => structuredClone(condition))
  }

  async trySatisfy(id: string, satisfaction: WaitSatisfaction): Promise<boolean> {
    const condition = this.conditions.get(id)
    if (condition?.status !== 'open') return false
    this.conditions.set(id, {
      ...condition,
      status: 'satisfied',
      satisfiedAt: satisfaction.at,
      satisfaction: structuredClone(satisfaction),
    })
    return true
  }

  async cancelForRun(runId: RunId): Promise<void> {
    for (const [id, condition] of this.conditions) {
      if (condition.runId === runId && condition.status === 'open') {
        this.conditions.set(id, { ...condition, status: 'cancelled' })
      }
    }
  }

  async addSupplemental(entry: SupplementalInput): Promise<void> {
    this.supplementals.push(structuredClone(entry))
  }

  async listSupplemental(runId: RunId): Promise<readonly SupplementalInput[]> {
    return this.supplementals
      .filter((entry) => entry.runId === runId)
      .map((entry) => structuredClone(entry))
  }

  async markSupplementalPromoted(waitId: string, at: Date): Promise<void> {
    for (const [index, entry] of this.supplementals.entries()) {
      if (entry.waitId === waitId) {
        this.supplementals[index] = { ...entry, promotedAt: structuredClone(at) }
      }
    }
  }
}

class InMemoryRunGraphStateRepository implements RunGraphStateRepository {
  private readonly rows = new Map<RunId, RunGraphState>()

  async save(state: RunGraphState): Promise<void> {
    this.rows.set(state.runId, structuredClone(state))
  }

  async get(runId: RunId): Promise<RunGraphState | undefined> {
    const state = this.rows.get(runId)
    return state ? structuredClone(state) : undefined
  }

  async delete(runId: RunId): Promise<void> {
    this.rows.delete(runId)
  }
}

class InMemoryExecutionSpecRepository implements ExecutionSpecRepository {
  private readonly rows = new Map<string, ExecutionSpecification>()

  private key(runId: RunId, revision: number): string {
    return `${runId}\u0000${revision}`
  }

  async save(spec: ExecutionSpecification): Promise<void> {
    this.rows.set(this.key(spec.runId, spec.revision), structuredClone(spec))
  }

  async get(runId: RunId, revision: number): Promise<ExecutionSpecification | undefined> {
    const spec = this.rows.get(this.key(runId, revision))
    return spec ? structuredClone(spec) : undefined
  }

  async latest(runId: RunId): Promise<ExecutionSpecification | undefined> {
    const revisions = await this.listRevisions(runId)
    return revisions[revisions.length - 1]
  }

  async listRevisions(runId: RunId): Promise<readonly ExecutionSpecification[]> {
    return [...this.rows.values()]
      .filter((spec) => spec.runId === runId)
      .sort((a, b) => a.revision - b.revision)
      .map((spec) => structuredClone(spec))
  }
}

class InMemoryCheckpointRepository implements CheckpointRepository {
  private readonly rows: Checkpoint[] = []

  async save(checkpoint: Checkpoint): Promise<void> {
    this.rows.push(structuredClone(checkpoint))
  }

  async latestForRun(runId: RunId): Promise<Checkpoint | undefined> {
    const forRun = await this.listForRun(runId)
    return forRun[forRun.length - 1]
  }

  async listForRun(runId: RunId): Promise<readonly Checkpoint[]> {
    // Stable sort: insertion order breaks created_at ties, mirroring the
    // SQLite adapter's rowid tie-breaker.
    return this.rows
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((checkpoint) => structuredClone(checkpoint))
  }
}

class InMemoryExperimentRepository implements ExperimentRepository {
  private readonly rows = new Map<string, ExperimentRecord>()

  async save(record: ExperimentRecord): Promise<void> {
    this.rows.set(record.id, structuredClone(record))
  }

  async get(id: string): Promise<ExperimentRecord | undefined> {
    const record = this.rows.get(id)
    return record ? structuredClone(record) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly ExperimentRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.runId === runId)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record))
  }
}

class InMemoryJudgmentRepository implements JudgmentRepository {
  private readonly rows: JudgmentOutcome[] = []

  async save(outcome: JudgmentOutcome): Promise<void> {
    this.rows.push(structuredClone(outcome))
  }

  async listForExperiment(experimentId: string): Promise<readonly JudgmentOutcome[]> {
    return this.rows
      .filter((outcome) => outcome.experimentId === experimentId)
      .map((outcome) => structuredClone(outcome))
  }

  async listForPeriod(start: Date, end: Date): Promise<readonly JudgmentOutcome[]> {
    // Half-open [start, end), mirroring the SQLite adapter and usage totals.
    return this.rows
      .filter((outcome) => outcome.at >= start && outcome.at < end)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((outcome) => structuredClone(outcome))
  }
}

class InMemoryScheduleRepository implements ScheduleRepository {
  private readonly rows: ScheduleFiring[] = []

  async recordFiring(firing: ScheduleFiring): Promise<void> {
    this.rows.push(structuredClone(firing))
  }

  async lastFiring(scheduleName: string): Promise<ScheduleFiring | undefined> {
    // Stable sort keeps insertion order for same-due firings; the last
    // element mirrors the SQLite adapter's due_at DESC, seq DESC pick.
    const forSchedule = this.rows
      .filter((firing) => firing.scheduleName === scheduleName)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    const last = forSchedule[forSchedule.length - 1]
    return last ? structuredClone(last) : undefined
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
  readonly definitions: DefinitionStore
  readonly waits: WaitRepository = new InMemoryWaitRepository()
  readonly runGraphs: RunGraphStateRepository = new InMemoryRunGraphStateRepository()
  readonly specs: ExecutionSpecRepository = new InMemoryExecutionSpecRepository()
  readonly checkpoints: CheckpointRepository = new InMemoryCheckpointRepository()
  readonly experiments: ExperimentRepository = new InMemoryExperimentRepository()
  readonly judgments: JudgmentRepository = new InMemoryJudgmentRepository()
  readonly schedules: ScheduleRepository = new InMemoryScheduleRepository()

  constructor(options: InMemoryPersistenceProviderOptions = {}) {
    this.usage = new InMemoryUsageRepository(options.clock ?? systemClock)
    this.definitions = new InMemoryDefinitionStore(options.clock ?? systemClock)
  }

  async migrate(): Promise<void> {
    // No schema to migrate; the shape lives in the TypeScript types.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
