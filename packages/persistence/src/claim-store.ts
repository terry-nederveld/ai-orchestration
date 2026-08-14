/**
 * SQLite-backed `ClaimStore`. Atomicity of `tryClaim` comes from a single
 * conditional `INSERT ... ON CONFLICT DO UPDATE ... WHERE` statement rather
 * than a read-then-write in application code: the WHERE clause only lets the
 * update through when there is no active claim or the claim is already held
 * by the requesting run, so a concurrent claim by a different run leaves the
 * row untouched.
 */

import type { ClaimStore, RunId, WorkItemId } from '@overture/core'
import { asId } from '@overture/core'
import type { Database } from './database.js'

interface ClaimRow {
  readonly run_id: string
  readonly released_at: string | null
}

export class SqliteClaimStore implements ClaimStore {
  constructor(private readonly db: Database) {}

  async tryClaim(workItemId: WorkItemId, runId: RunId): Promise<boolean> {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO claims (work_item_id, run_id, claimed_at, released_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(work_item_id) DO UPDATE SET
         run_id = excluded.run_id,
         claimed_at = excluded.claimed_at,
         released_at = NULL
       WHERE claims.released_at IS NOT NULL OR claims.run_id = excluded.run_id`,
      [workItemId, runId, now],
    )
    const row = this.db.get<ClaimRow>(
      'SELECT run_id, released_at FROM claims WHERE work_item_id = ?',
      [workItemId],
    )
    return row !== undefined && row.released_at === null && row.run_id === runId
  }

  async release(workItemId: WorkItemId, runId: RunId): Promise<void> {
    this.db.run(
      'UPDATE claims SET released_at = ? WHERE work_item_id = ? AND run_id = ? AND released_at IS NULL',
      [new Date().toISOString(), workItemId, runId],
    )
  }

  async activeClaim(workItemId: WorkItemId): Promise<RunId | undefined> {
    const row = this.db.get<{ run_id: string }>(
      'SELECT run_id FROM claims WHERE work_item_id = ? AND released_at IS NULL',
      [workItemId],
    )
    return row ? asId<'run'>(row.run_id) : undefined
  }
}
