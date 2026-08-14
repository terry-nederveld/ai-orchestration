/**
 * Numbered SQL migrations applied in order inside a transaction, recorded in
 * a `migrations` bookkeeping table so `migrate()` is idempotent: re-running
 * it after the schema is up to date is a no-op.
 */

import type { Database } from './database.js'

interface Migration {
  readonly id: number
  readonly name: string
  readonly sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_runs',
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        state TEXT NOT NULL,
        current_step_id TEXT,
        workspace_id TEXT,
        session_ids TEXT NOT NULL,
        usage TEXT,
        outcome TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        history TEXT NOT NULL
      );
      CREATE INDEX idx_runs_state ON runs(state);
      CREATE INDEX idx_runs_work_item_id ON runs(work_item_id);
    `,
  },
  {
    id: 2,
    name: 'create_sessions',
    sql: `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        system_prompt TEXT,
        messages TEXT NOT NULL,
        provider_session_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_run_id ON sessions(run_id);
    `,
  },
  {
    id: 3,
    name: 'create_events',
    sql: `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_events_run_id ON events(run_id);
      CREATE INDEX idx_events_type ON events(type);
    `,
  },
  {
    id: 4,
    name: 'create_claims',
    sql: `
      CREATE TABLE claims (
        work_item_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        released_at TEXT
      );
    `,
  },
  {
    id: 5,
    name: 'create_usage_records',
    sql: `
      CREATE TABLE usage_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        estimated_cost_usd REAL,
        subscription_requests INTEGER,
        duration_ms INTEGER NOT NULL,
        turns INTEGER NOT NULL,
        subagents INTEGER NOT NULL
      );
      CREATE INDEX idx_usage_records_recorded_at ON usage_records(recorded_at);
      CREATE INDEX idx_usage_records_run_id ON usage_records(run_id);
    `,
  },
  {
    id: 6,
    name: 'create_config',
    sql: `
      CREATE TABLE config (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
    `,
  },
]

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(db.all<{ id: number }>('SELECT id FROM migrations').map((row) => row.id))
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.run('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        new Date().toISOString(),
      ])
    })
  }
}
