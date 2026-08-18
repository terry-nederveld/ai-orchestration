/**
 * SQLite-backed `WaitRepository` (ADR-0019). `trySatisfy` gets its
 * first-valid-response-wins atomicity the same way the claim store does:
 * a single conditional UPDATE guarded by `status = 'open'`, so of two
 * concurrent satisfactions exactly one observes an open row and wins.
 */

import type { SQLInputValue } from 'node:sqlite'
import type {
  HumanInput,
  HumanInputRequestSpec,
  RunId,
  SupplementalInput,
  WaitCondition,
  WaitConditionStatus,
  WaitKind,
  WaitRepository,
  WaitSatisfaction,
} from '@overture/core'
import { asId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, fromJsonOrUndefined, toJson } from './serde.js'

interface WaitConditionRow extends Row {
  readonly id: string
  readonly run_id: string
  readonly node_id: string
  readonly kind: string
  readonly parameters: string
  readonly request: string | null
  readonly status: string
  readonly created_at: string
  readonly due_at: string | null
  readonly satisfied_at: string | null
  readonly satisfaction: string | null
}

interface StoredHumanInput extends Omit<HumanInput, 'at'> {
  readonly at: string
}

interface StoredSatisfaction {
  readonly kind: WaitKind
  readonly at: string
  readonly input?: StoredHumanInput
  readonly event?: Readonly<Record<string, unknown>>
}

function toStoredSatisfaction(satisfaction: WaitSatisfaction): StoredSatisfaction {
  return {
    kind: satisfaction.kind,
    at: satisfaction.at.toISOString(),
    ...(satisfaction.input ? { input: toStoredInput(satisfaction.input) } : {}),
    ...(satisfaction.event ? { event: satisfaction.event } : {}),
  }
}

function fromStoredSatisfaction(stored: StoredSatisfaction): WaitSatisfaction {
  return {
    kind: stored.kind,
    at: new Date(stored.at),
    ...(stored.input ? { input: fromStoredInput(stored.input) } : {}),
    ...(stored.event ? { event: stored.event } : {}),
  }
}

function toStoredInput(input: HumanInput): StoredHumanInput {
  return { ...input, at: input.at.toISOString() }
}

function fromStoredInput(stored: StoredHumanInput): HumanInput {
  return { ...stored, at: new Date(stored.at) }
}

function rowToCondition(row: WaitConditionRow): WaitCondition {
  const satisfaction = fromJsonOrUndefined<StoredSatisfaction>(row.satisfaction)
  return {
    id: row.id,
    runId: asId<'run'>(row.run_id),
    nodeId: row.node_id,
    kind: row.kind as WaitKind,
    parameters: fromJson<Record<string, unknown>>(row.parameters),
    ...(row.request != null ? { request: fromJson<HumanInputRequestSpec>(row.request) } : {}),
    status: row.status as WaitConditionStatus,
    createdAt: new Date(row.created_at),
    ...(row.due_at != null ? { dueAt: new Date(row.due_at) } : {}),
    ...(row.satisfied_at != null ? { satisfiedAt: new Date(row.satisfied_at) } : {}),
    ...(satisfaction ? { satisfaction: fromStoredSatisfaction(satisfaction) } : {}),
  }
}

export class SqliteWaitRepository implements WaitRepository {
  constructor(private readonly db: Database) {}

  async save(condition: WaitCondition): Promise<void> {
    this.db.run(
      `INSERT INTO wait_conditions (
         id, run_id, node_id, kind, parameters, request, status,
         created_at, due_at, satisfied_at, satisfaction
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         node_id = excluded.node_id,
         kind = excluded.kind,
         parameters = excluded.parameters,
         request = excluded.request,
         status = excluded.status,
         created_at = excluded.created_at,
         due_at = excluded.due_at,
         satisfied_at = excluded.satisfied_at,
         satisfaction = excluded.satisfaction`,
      [
        condition.id,
        condition.runId,
        condition.nodeId,
        condition.kind,
        toJson(condition.parameters),
        condition.request ? toJson(condition.request) : null,
        condition.status,
        condition.createdAt.toISOString(),
        condition.dueAt?.toISOString() ?? null,
        condition.satisfiedAt?.toISOString() ?? null,
        condition.satisfaction ? toJson(toStoredSatisfaction(condition.satisfaction)) : null,
      ],
    )
  }

  async get(id: string): Promise<WaitCondition | undefined> {
    const row = this.db.get<WaitConditionRow>('SELECT * FROM wait_conditions WHERE id = ?', [id])
    return row ? rowToCondition(row) : undefined
  }

  async listOpen(filter?: {
    readonly runId?: RunId
    readonly kind?: WaitKind
    readonly dueBefore?: Date
  }): Promise<readonly WaitCondition[]> {
    const clauses = ["status = 'open'"]
    const params: SQLInputValue[] = []
    if (filter?.runId) {
      clauses.push('run_id = ?')
      params.push(filter.runId)
    }
    if (filter?.kind) {
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter?.dueBefore) {
      clauses.push('due_at IS NOT NULL AND due_at < ?')
      params.push(filter.dueBefore.toISOString())
    }
    return this.db
      .all<WaitConditionRow>(
        `SELECT * FROM wait_conditions WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC`,
        params,
      )
      .map(rowToCondition)
  }

  async trySatisfy(id: string, satisfaction: WaitSatisfaction): Promise<boolean> {
    const changes = this.db.run(
      `UPDATE wait_conditions
       SET status = 'satisfied', satisfied_at = ?, satisfaction = ?
       WHERE id = ? AND status = 'open'`,
      [satisfaction.at.toISOString(), toJson(toStoredSatisfaction(satisfaction)), id],
    )
    return changes.changes > 0
  }

  async cancelForRun(runId: RunId): Promise<void> {
    this.db.run(
      "UPDATE wait_conditions SET status = 'cancelled' WHERE run_id = ? AND status = 'open'",
      [runId],
    )
  }

  async addSupplemental(entry: SupplementalInput): Promise<void> {
    this.db.run(
      'INSERT INTO supplemental_inputs (wait_id, run_id, input, promoted_at) VALUES (?, ?, ?, ?)',
      [
        entry.waitId,
        entry.runId,
        toJson(toStoredInput(entry.input)),
        entry.promotedAt?.toISOString() ?? null,
      ],
    )
  }

  async listSupplemental(runId: RunId): Promise<readonly SupplementalInput[]> {
    return this.db
      .all<{ wait_id: string; run_id: string; input: string; promoted_at: string | null }>(
        'SELECT * FROM supplemental_inputs WHERE run_id = ? ORDER BY seq ASC',
        [runId],
      )
      .map((row) => ({
        waitId: row.wait_id,
        runId: asId<'run'>(row.run_id),
        input: fromStoredInput(fromJson<StoredHumanInput>(row.input)),
        ...(row.promoted_at != null ? { promotedAt: new Date(row.promoted_at) } : {}),
      }))
  }

  async markSupplementalPromoted(waitId: string, at: Date): Promise<void> {
    this.db.run('UPDATE supplemental_inputs SET promoted_at = ? WHERE wait_id = ?', [
      at.toISOString(),
      waitId,
    ])
  }
}
