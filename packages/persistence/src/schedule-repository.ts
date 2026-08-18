/**
 * SQLite-backed `ScheduleRepository` (mission §22–§23). Firings are an
 * append-only log; `lastFiring` is the most recent due time for a schedule
 * (rowid breaks ties for same-due re-recordings).
 */

import type { ScheduleFiring, ScheduleRepository } from '@overture/core'
import type { Database, Row } from './database.js'

interface ScheduleFiringRow extends Row {
  readonly schedule_name: string
  readonly due_at: string
  readonly fired_at: string | null
  readonly run_id: string | null
}

function rowToFiring(row: ScheduleFiringRow): ScheduleFiring {
  return {
    scheduleName: row.schedule_name,
    dueAt: new Date(row.due_at),
    ...(row.fired_at != null ? { firedAt: new Date(row.fired_at) } : {}),
    ...(row.run_id != null ? { runId: row.run_id } : {}),
  }
}

export class SqliteScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Database) {}

  async recordFiring(firing: ScheduleFiring): Promise<void> {
    this.db.run(
      'INSERT INTO schedule_firings (schedule_name, due_at, fired_at, run_id) VALUES (?, ?, ?, ?)',
      [
        firing.scheduleName,
        firing.dueAt.toISOString(),
        firing.firedAt?.toISOString() ?? null,
        firing.runId ?? null,
      ],
    )
  }

  async lastFiring(scheduleName: string): Promise<ScheduleFiring | undefined> {
    const row = this.db.get<ScheduleFiringRow>(
      'SELECT * FROM schedule_firings WHERE schedule_name = ? ORDER BY due_at DESC, seq DESC LIMIT 1',
      [scheduleName],
    )
    return row ? rowToFiring(row) : undefined
  }
}
