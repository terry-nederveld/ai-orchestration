/**
 * SQLite-backed `RunGraphStateRepository` (ADR-0017). The whole
 * `RunGraphState` is one JSON document — the engine always loads and saves
 * it atomically per settlement — with run_id/snapshot_id/updated_at lifted
 * into columns for queryability.
 */

import type { GraphNodeResult, RunGraphState, RunGraphStateRepository, RunId } from '@overture/core'
import { asId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface RunGraphStateRow extends Row {
  readonly run_id: string
  readonly snapshot_id: string
  readonly state: string
  readonly updated_at: string
}

interface StoredGraphNodeResult extends Omit<GraphNodeResult, 'startedAt' | 'settledAt'> {
  readonly startedAt: string
  readonly settledAt: string
}

interface StoredRunGraphState
  extends Omit<RunGraphState, 'runId' | 'nodeResults' | 'resultHistory' | 'updatedAt'> {
  readonly runId: string
  readonly nodeResults: Readonly<Record<string, StoredGraphNodeResult>>
  readonly resultHistory: readonly StoredGraphNodeResult[]
  readonly updatedAt: string
}

function toStoredResult(result: GraphNodeResult): StoredGraphNodeResult {
  return {
    ...result,
    startedAt: result.startedAt.toISOString(),
    settledAt: result.settledAt.toISOString(),
  }
}

function fromStoredResult(stored: StoredGraphNodeResult): GraphNodeResult {
  return {
    ...stored,
    startedAt: new Date(stored.startedAt),
    settledAt: new Date(stored.settledAt),
  }
}

export class SqliteRunGraphStateRepository implements RunGraphStateRepository {
  constructor(private readonly db: Database) {}

  async save(state: RunGraphState): Promise<void> {
    const stored: StoredRunGraphState = {
      ...state,
      nodeResults: Object.fromEntries(
        Object.entries(state.nodeResults).map(([nodeId, result]) => [
          nodeId,
          toStoredResult(result),
        ]),
      ),
      resultHistory: state.resultHistory.map(toStoredResult),
      updatedAt: state.updatedAt.toISOString(),
    }
    this.db.run(
      `INSERT INTO run_graph_state (run_id, snapshot_id, state, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         snapshot_id = excluded.snapshot_id,
         state = excluded.state,
         updated_at = excluded.updated_at`,
      [state.runId, state.snapshotId, toJson(stored), state.updatedAt.toISOString()],
    )
  }

  async get(runId: RunId): Promise<RunGraphState | undefined> {
    const row = this.db.get<RunGraphStateRow>('SELECT * FROM run_graph_state WHERE run_id = ?', [
      runId,
    ])
    if (!row) return undefined
    const stored = fromJson<StoredRunGraphState>(row.state)
    return {
      ...stored,
      runId: asId<'run'>(stored.runId),
      nodeResults: Object.fromEntries(
        Object.entries(stored.nodeResults).map(([nodeId, result]) => [
          nodeId,
          fromStoredResult(result),
        ]),
      ),
      resultHistory: stored.resultHistory.map(fromStoredResult),
      updatedAt: new Date(stored.updatedAt),
    }
  }

  async delete(runId: RunId): Promise<void> {
    this.db.run('DELETE FROM run_graph_state WHERE run_id = ?', [runId])
  }
}
