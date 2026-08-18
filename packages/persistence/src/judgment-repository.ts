/**
 * SQLite-backed `JudgmentRepository` (mission §15–§16). Outcomes are
 * append-only; `at` is lifted into an indexed column so period-bounded
 * observability queries follow the same half-open [start, end) convention
 * as the usage repository.
 */

import type { JudgmentOutcome, JudgmentRepository } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface JudgmentRow extends Row {
  readonly experiment_id: string
  readonly outcome: string
  readonly at: string
}

interface StoredJudgmentOutcome extends Omit<JudgmentOutcome, 'at'> {
  readonly at: string
}

function rowToOutcome(row: JudgmentRow): JudgmentOutcome {
  const stored = fromJson<StoredJudgmentOutcome>(row.outcome)
  return { ...stored, at: new Date(stored.at) }
}

export class SqliteJudgmentRepository implements JudgmentRepository {
  constructor(private readonly db: Database) {}

  async save(outcome: JudgmentOutcome): Promise<void> {
    const stored: StoredJudgmentOutcome = { ...outcome, at: outcome.at.toISOString() }
    this.db.run('INSERT INTO judgments (experiment_id, outcome, at) VALUES (?, ?, ?)', [
      outcome.experimentId,
      toJson(stored),
      outcome.at.toISOString(),
    ])
  }

  async listForExperiment(experimentId: string): Promise<readonly JudgmentOutcome[]> {
    return this.db
      .all<JudgmentRow>('SELECT * FROM judgments WHERE experiment_id = ? ORDER BY seq ASC', [
        experimentId,
      ])
      .map(rowToOutcome)
  }

  async listForPeriod(start: Date, end: Date): Promise<readonly JudgmentOutcome[]> {
    return this.db
      .all<JudgmentRow>('SELECT * FROM judgments WHERE at >= ? AND at < ? ORDER BY at ASC', [
        start.toISOString(),
        end.toISOString(),
      ])
      .map(rowToOutcome)
  }
}
