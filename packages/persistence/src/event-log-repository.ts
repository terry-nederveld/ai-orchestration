/**
 * SQLite-backed `EventLogRepository`. Events are append-only; a monotonic
 * `seq` column (independent of the caller-supplied event id) orders rows so
 * `listForRun`'s `afterEventId` cursor is well defined.
 */

import type { SQLInputValue } from 'node:sqlite'
import type {
  EventLogRepository,
  OrchestratorEvent,
  OrchestratorEventType,
  RunId,
} from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface EventRow extends Row {
  readonly seq: number
  readonly id: string
  readonly run_id: string | null
  readonly type: string
  readonly at: string
  readonly payload: string
}

function rowToEvent(row: EventRow): OrchestratorEvent {
  const payload = fromJson<Record<string, unknown>>(row.payload)
  return { ...payload, at: new Date(row.at) } as OrchestratorEvent
}

export class SqliteEventLogRepository implements EventLogRepository {
  constructor(private readonly db: Database) {}

  async append(event: OrchestratorEvent): Promise<void> {
    this.db.run('INSERT INTO events (id, run_id, type, at, payload) VALUES (?, ?, ?, ?, ?)', [
      event.id,
      event.runId ?? null,
      event.type,
      event.at.toISOString(),
      toJson({ ...event, at: event.at.toISOString() }),
    ])
  }

  async listForRun(runId: RunId, afterEventId?: string): Promise<readonly OrchestratorEvent[]> {
    let afterSeq = 0
    if (afterEventId) {
      const cursor = this.db.get<{ seq: number }>('SELECT seq FROM events WHERE id = ?', [
        afterEventId,
      ])
      afterSeq = cursor?.seq ?? 0
    }
    return this.db
      .all<EventRow>('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC', [
        runId,
        afterSeq,
      ])
      .map(rowToEvent)
  }

  async list(filter?: {
    readonly types?: readonly OrchestratorEventType[]
    readonly limit?: number
  }): Promise<readonly OrchestratorEvent[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (filter?.types && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types)
    }
    let sql = 'SELECT * FROM events'
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ' ORDER BY seq DESC'
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }
    return this.db.all<EventRow>(sql, params).map(rowToEvent)
  }
}
