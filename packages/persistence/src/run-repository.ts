/**
 * SQLite-backed `RunRepository`. Run state history and usage don't need
 * relational modeling, so they're stored as JSON columns alongside the
 * queryable scalar fields (state, work item id).
 */

import type { SQLInputValue } from 'node:sqlite'
import type {
  AgentOutcome,
  Run,
  RunRepository,
  RunState,
  RunStateChange,
  UsageRecord,
} from '@overture/core'
import { asId, type RunId, type WorkItemId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface RunRow extends Row {
  readonly id: string
  readonly work_item_id: string
  readonly workflow_name: string
  readonly state: string
  readonly current_step_id: string | null
  readonly workspace_id: string | null
  readonly session_ids: string
  readonly usage: string | null
  readonly outcome: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly history: string
}

interface StoredStateChange {
  readonly from: RunState
  readonly to: RunState
  readonly at: string
  readonly reason?: string
}

function rowToRun(row: RunRow): Run {
  return {
    id: asId<'run'>(row.id),
    workItemId: asId<'work-item'>(row.work_item_id),
    workflowName: row.workflow_name,
    state: row.state as RunState,
    ...(row.current_step_id != null ? { currentStepId: row.current_step_id } : {}),
    ...(row.workspace_id != null ? { workspaceId: asId<'workspace'>(row.workspace_id) } : {}),
    sessionIds: fromJson<string[]>(row.session_ids).map((id) => asId<'session'>(id)),
    ...(row.usage != null ? { usage: fromJson<UsageRecord>(row.usage) } : {}),
    ...(row.outcome != null ? { outcome: row.outcome as AgentOutcome } : {}),
    ...(row.error != null ? { error: row.error } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    history: fromJson<StoredStateChange[]>(row.history).map(
      (change): RunStateChange => ({
        from: change.from,
        to: change.to,
        at: new Date(change.at),
        ...(change.reason != null ? { reason: change.reason } : {}),
      }),
    ),
  }
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Database) {}

  async save(run: Run): Promise<void> {
    const history: StoredStateChange[] = run.history.map((change) => ({
      from: change.from,
      to: change.to,
      at: change.at.toISOString(),
      ...(change.reason != null ? { reason: change.reason } : {}),
    }))
    this.db.run(
      `INSERT INTO runs (
         id, work_item_id, workflow_name, state, current_step_id, workspace_id,
         session_ids, usage, outcome, error, created_at, updated_at, history
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         work_item_id = excluded.work_item_id,
         workflow_name = excluded.workflow_name,
         state = excluded.state,
         current_step_id = excluded.current_step_id,
         workspace_id = excluded.workspace_id,
         session_ids = excluded.session_ids,
         usage = excluded.usage,
         outcome = excluded.outcome,
         error = excluded.error,
         updated_at = excluded.updated_at,
         history = excluded.history`,
      [
        run.id,
        run.workItemId,
        run.workflowName,
        run.state,
        run.currentStepId ?? null,
        run.workspaceId ?? null,
        toJson(run.sessionIds),
        run.usage ? toJson(run.usage) : null,
        run.outcome ?? null,
        run.error ?? null,
        run.createdAt.toISOString(),
        run.updatedAt.toISOString(),
        toJson(history),
      ],
    )
  }

  async get(id: RunId): Promise<Run | undefined> {
    const row = this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [id])
    return row ? rowToRun(row) : undefined
  }

  async list(filter?: {
    readonly states?: readonly string[]
    readonly workItemId?: WorkItemId
    readonly limit?: number
  }): Promise<readonly Run[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (filter?.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => '?').join(', ')})`)
      params.push(...filter.states)
    }
    if (filter?.workItemId) {
      clauses.push('work_item_id = ?')
      params.push(filter.workItemId)
    }
    let sql = 'SELECT * FROM runs'
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ' ORDER BY created_at DESC'
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }
    return this.db.all<RunRow>(sql, params).map(rowToRun)
  }
}
