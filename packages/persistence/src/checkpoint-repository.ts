/**
 * SQLite-backed `CheckpointRepository` (mission §6). Checkpoints are
 * append-only; `latestForRun` orders by created_at with rowid as the
 * tie-breaker so same-timestamp checkpoints resolve to the most recently
 * written one.
 */

import type { Checkpoint, CheckpointRepository, RunId } from '@overture/core'
import { asId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface CheckpointRow extends Row {
  readonly id: string
  readonly run_id: string
  readonly node_id: string
  readonly strategy: string
  readonly coordinates: string
  readonly summary: string
  readonly spec_revision: number
  readonly created_at: string
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    runId: asId<'run'>(row.run_id),
    nodeId: row.node_id,
    strategy: row.strategy,
    createdAt: new Date(row.created_at),
    coordinates: fromJson<Record<string, unknown>>(row.coordinates),
    summary: row.summary,
    specRevision: row.spec_revision,
  }
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: Database) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    this.db.run(
      `INSERT INTO checkpoints (
         id, run_id, node_id, strategy, coordinates, summary, spec_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkpoint.id,
        checkpoint.runId,
        checkpoint.nodeId,
        checkpoint.strategy,
        toJson(checkpoint.coordinates),
        checkpoint.summary,
        checkpoint.specRevision,
        checkpoint.createdAt.toISOString(),
      ],
    )
  }

  async latestForRun(runId: RunId): Promise<Checkpoint | undefined> {
    const row = this.db.get<CheckpointRow>(
      'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [runId],
    )
    return row ? rowToCheckpoint(row) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly Checkpoint[]> {
    return this.db
      .all<CheckpointRow>(
        'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
        [runId],
      )
      .map(rowToCheckpoint)
  }
}
