import { describe, expect, it } from 'vitest'
import { Database } from './database.js'
import { migrate } from './migrations.js'

function tableNames(db: Database): string[] {
  return db
    .all<{ name: string }>(
      // sqlite_sequence is created automatically by SQLite for AUTOINCREMENT
      // columns (events, usage_records) and isn't one of our migrations.
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .map((row) => row.name)
}

describe('migrate', () => {
  it('creates the expected schema', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(tableNames(db)).toEqual([
      'checkpoints',
      'claims',
      'config',
      'definition_lifecycles',
      'definition_versions',
      'events',
      'execution_specs',
      'experiments',
      'judgments',
      'migrations',
      'run_graph_state',
      'runs',
      'schedule_firings',
      'sessions',
      'snapshots',
      'supplemental_inputs',
      'usage_records',
      'wait_conditions',
    ])
  })

  it('is idempotent: re-running does not error or duplicate migration records', () => {
    const db = new Database(':memory:')
    migrate(db)
    const tablesAfterFirst = tableNames(db)
    const countAfterFirst = db.get<{ n: number }>('SELECT COUNT(*) as n FROM migrations')?.n

    expect(() => migrate(db)).not.toThrow()
    migrate(db)

    expect(tableNames(db)).toEqual(tablesAfterFirst)
    expect(db.get<{ n: number }>('SELECT COUNT(*) as n FROM migrations')?.n).toBe(countAfterFirst)
  })

  it('leaves data inserted between migrate() calls untouched', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.run('INSERT INTO config (namespace, key, value) VALUES (?, ?, ?)', ['ns', 'k', '"v"'])

    migrate(db)

    const row = db.get<{ value: string }>(
      'SELECT value FROM config WHERE namespace = ? AND key = ?',
      ['ns', 'k'],
    )
    expect(row?.value).toBe('"v"')
  })
})
