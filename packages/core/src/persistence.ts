/**
 * Persistence ports. Repository interfaces keep the domain free of storage
 * concerns; SQLite is the first adapter, replaceable by a server database.
 */

import type { UsageRecord } from './budget.js'
import type { CheckpointRepository } from './checkpoints.js'
import type { DefinitionStore } from './definitions.js'
import type { OrchestratorEvent } from './events.js'
import type { ExecutionSpecRepository } from './execution-spec.js'
import type { ExperimentRepository, JudgmentRepository } from './experiments.js'
import type { RunId, SessionId, WorkItemId } from './ids.js'
import type { ScheduleRepository } from './lanes.js'
import type { Message } from './model.js'
import type { Run } from './run.js'
import type { RunGraphStateRepository } from './run-graph.js'
import type { WaitRepository } from './waits.js'

export interface RunRepository {
  save(run: Run): Promise<void>
  get(id: RunId): Promise<Run | undefined>
  list(filter?: {
    readonly states?: readonly string[]
    readonly workItemId?: WorkItemId
    readonly limit?: number
  }): Promise<readonly Run[]>
}

/** Persisted conversation state enabling resume after restart. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly provider: string
  readonly model?: string
  readonly systemPrompt?: string
  readonly messages: readonly Message[]
  readonly providerSessionId?: string
  readonly updatedAt: Date
}

export interface SessionRepository {
  save(snapshot: SessionSnapshot): Promise<void>
  get(id: SessionId): Promise<SessionSnapshot | undefined>
  listForRun(runId: RunId): Promise<readonly SessionSnapshot[]>
}

export interface EventLogRepository {
  append(event: OrchestratorEvent): Promise<void>
  listForRun(runId: RunId, afterEventId?: string): Promise<readonly OrchestratorEvent[]>
  list(filter?: {
    readonly types?: readonly string[]
    readonly limit?: number
  }): Promise<readonly OrchestratorEvent[]>
}

/**
 * Authoritative idempotent claim store. A work item can be claimed by at most
 * one active run; `tryClaim` must be atomic.
 */
export interface ClaimStore {
  tryClaim(workItemId: WorkItemId, runId: RunId): Promise<boolean>
  release(workItemId: WorkItemId, runId: RunId): Promise<void>
  activeClaim(workItemId: WorkItemId): Promise<RunId | undefined>
}

export interface UsageRepository {
  record(runId: RunId, usage: UsageRecord): Promise<void>
  totalsForPeriod(periodStart: Date, periodEnd: Date): Promise<readonly UsageRecord[]>
}

/** Namespaced key-value configuration persistence (non-secret only). */
export interface ConfigRepository {
  get<T>(namespace: string, key: string): Promise<T | undefined>
  set<T>(namespace: string, key: string, value: T): Promise<void>
  delete(namespace: string, key: string): Promise<void>
  list(namespace: string): Promise<Readonly<Record<string, unknown>>>
}

/** Aggregate persistence port a storage adapter implements. */
export interface PersistenceProvider {
  readonly id: string
  readonly runs: RunRepository
  readonly sessions: SessionRepository
  readonly events: EventLogRepository
  readonly claims: ClaimStore
  readonly usage: UsageRepository
  readonly config: ConfigRepository
  readonly definitions: DefinitionStore
  readonly waits: WaitRepository
  readonly runGraphs: RunGraphStateRepository
  readonly specs: ExecutionSpecRepository
  readonly checkpoints: CheckpointRepository
  readonly experiments: ExperimentRepository
  readonly judgments: JudgmentRepository
  readonly schedules: ScheduleRepository
  /** Apply pending schema migrations. Idempotent. */
  migrate(): Promise<void>
  close(): Promise<void>
}
