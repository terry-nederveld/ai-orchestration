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
  {
    id: 7,
    name: 'create_definitions',
    sql: `
      CREATE TABLE definition_versions (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        document TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, name, version)
      );
      CREATE TABLE definition_lifecycles (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'draft',
        PRIMARY KEY (kind, name)
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        definitions TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 8,
    name: 'create_waits',
    sql: `
      CREATE TABLE wait_conditions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        parameters TEXT NOT NULL,
        request TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        due_at TEXT,
        satisfied_at TEXT,
        satisfaction TEXT
      );
      CREATE INDEX idx_wait_conditions_status_due_at ON wait_conditions(status, due_at);
      CREATE INDEX idx_wait_conditions_run_id ON wait_conditions(run_id);
      CREATE TABLE supplemental_inputs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        wait_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        input TEXT NOT NULL,
        promoted_at TEXT
      );
      CREATE INDEX idx_supplemental_inputs_run_id ON supplemental_inputs(run_id);
      CREATE INDEX idx_supplemental_inputs_wait_id ON supplemental_inputs(wait_id);
    `,
  },
  {
    id: 9,
    name: 'create_run_graph_state',
    sql: `
      CREATE TABLE run_graph_state (
        run_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 10,
    name: 'create_execution_specs',
    sql: `
      CREATE TABLE execution_specs (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        spec TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, revision)
      );
    `,
  },
  {
    id: 11,
    name: 'create_checkpoints',
    sql: `
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        coordinates TEXT NOT NULL,
        summary TEXT NOT NULL,
        spec_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_checkpoints_run_id ON checkpoints(run_id);
    `,
  },
  {
    id: 12,
    name: 'create_experiments',
    sql: `
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_experiments_run_id ON experiments(run_id);
      CREATE TABLE judgments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_judgments_experiment_id ON judgments(experiment_id);
      CREATE INDEX idx_judgments_at ON judgments(at);
    `,
  },
  {
    id: 13,
    name: 'create_schedule_firings',
    sql: `
      CREATE TABLE schedule_firings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_name TEXT NOT NULL,
        due_at TEXT NOT NULL,
        fired_at TEXT,
        run_id TEXT
      );
      CREATE INDEX idx_schedule_firings_name_due_at ON schedule_firings(schedule_name, due_at);
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
