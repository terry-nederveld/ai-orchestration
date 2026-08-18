/**
 * SQLite-backed `ExperimentRepository` (mission §13). The record — with its
 * candidates, scores, and lessons — is one JSON document; run_id and
 * updated_at are lifted into columns for lookup and ordering.
 */

import type { ExperimentRecord, ExperimentRepository, RunId } from '@overture/core'
import { asId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface ExperimentRow extends Row {
  readonly id: string
  readonly run_id: string
  readonly record: string
  readonly updated_at: string
}

interface StoredExperimentRecord
  extends Omit<ExperimentRecord, 'runId' | 'createdAt' | 'updatedAt'> {
  readonly runId: string
  readonly createdAt: string
  readonly updatedAt: string
}

function rowToRecord(row: ExperimentRow): ExperimentRecord {
  const stored = fromJson<StoredExperimentRecord>(row.record)
  return {
    ...stored,
    runId: asId<'run'>(stored.runId),
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
  }
}

export class SqliteExperimentRepository implements ExperimentRepository {
  constructor(private readonly db: Database) {}

  async save(record: ExperimentRecord): Promise<void> {
    const stored: StoredExperimentRecord = {
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }
    this.db.run(
      `INSERT INTO experiments (id, run_id, record, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         record = excluded.record,
         updated_at = excluded.updated_at`,
      [record.id, record.runId, toJson(stored), record.updatedAt.toISOString()],
    )
  }

  async get(id: string): Promise<ExperimentRecord | undefined> {
    const row = this.db.get<ExperimentRow>('SELECT * FROM experiments WHERE id = ?', [id])
    return row ? rowToRecord(row) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly ExperimentRecord[]> {
    return this.db
      .all<ExperimentRow>(
        'SELECT * FROM experiments WHERE run_id = ? ORDER BY updated_at ASC, id ASC',
        [runId],
      )
      .map(rowToRecord)
  }
}
