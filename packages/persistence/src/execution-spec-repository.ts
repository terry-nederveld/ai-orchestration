/**
 * SQLite-backed `ExecutionSpecRepository`. Revisions are append-only and
 * immutable (mission §7), so the whole specification is one JSON document
 * keyed by (run_id, revision); a duplicate save of the same revision is a
 * conflict, surfaced by the primary key.
 */

import type { ExecutionSpecification, ExecutionSpecRepository, RunId } from '@overture/core'
import { asId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface ExecutionSpecRow extends Row {
  readonly run_id: string
  readonly revision: number
  readonly spec: string
  readonly created_at: string
}

interface StoredExecutionSpecification extends Omit<ExecutionSpecification, 'runId' | 'createdAt'> {
  readonly runId: string
  readonly createdAt: string
}

function rowToSpec(row: ExecutionSpecRow): ExecutionSpecification {
  const stored = fromJson<StoredExecutionSpecification>(row.spec)
  return {
    ...stored,
    runId: asId<'run'>(stored.runId),
    createdAt: new Date(stored.createdAt),
  }
}

export class SqliteExecutionSpecRepository implements ExecutionSpecRepository {
  constructor(private readonly db: Database) {}

  async save(spec: ExecutionSpecification): Promise<void> {
    const stored: StoredExecutionSpecification = {
      ...spec,
      createdAt: spec.createdAt.toISOString(),
    }
    this.db.run(
      'INSERT INTO execution_specs (run_id, revision, spec, created_at) VALUES (?, ?, ?, ?)',
      [spec.runId, spec.revision, toJson(stored), spec.createdAt.toISOString()],
    )
  }

  async get(runId: RunId, revision: number): Promise<ExecutionSpecification | undefined> {
    const row = this.db.get<ExecutionSpecRow>(
      'SELECT * FROM execution_specs WHERE run_id = ? AND revision = ?',
      [runId, revision],
    )
    return row ? rowToSpec(row) : undefined
  }

  async latest(runId: RunId): Promise<ExecutionSpecification | undefined> {
    const row = this.db.get<ExecutionSpecRow>(
      'SELECT * FROM execution_specs WHERE run_id = ? ORDER BY revision DESC LIMIT 1',
      [runId],
    )
    return row ? rowToSpec(row) : undefined
  }

  async listRevisions(runId: RunId): Promise<readonly ExecutionSpecification[]> {
    return this.db
      .all<ExecutionSpecRow>(
        'SELECT * FROM execution_specs WHERE run_id = ? ORDER BY revision ASC',
        [runId],
      )
      .map(rowToSpec)
  }
}
