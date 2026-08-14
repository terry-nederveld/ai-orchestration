/**
 * SQLite implementation of `PersistenceProvider`, backed by Node's built-in
 * `node:sqlite` module — no native npm dependency required. The database
 * path is a constructor argument; pass ':memory:' for an ephemeral store.
 */

import type { Clock, PersistenceProvider } from '@overture/core'
import { SqliteClaimStore } from './claim-store.js'
import { SqliteConfigRepository } from './config-repository.js'
import { Database } from './database.js'
import { SqliteEventLogRepository } from './event-log-repository.js'
import { migrate } from './migrations.js'
import { SqliteRunRepository } from './run-repository.js'
import { SqliteSessionRepository } from './session-repository.js'
import { SqliteUsageRepository } from './usage-repository.js'

export interface SqlitePersistenceProviderOptions {
  readonly clock?: Clock
}

export class SqlitePersistenceProvider implements PersistenceProvider {
  readonly id = 'sqlite'
  readonly runs: SqliteRunRepository
  readonly sessions: SqliteSessionRepository
  readonly events: SqliteEventLogRepository
  readonly claims: SqliteClaimStore
  readonly usage: SqliteUsageRepository
  readonly config: SqliteConfigRepository

  private readonly db: Database

  constructor(path: string, options: SqlitePersistenceProviderOptions = {}) {
    this.db = new Database(path)
    this.runs = new SqliteRunRepository(this.db)
    this.sessions = new SqliteSessionRepository(this.db)
    this.events = new SqliteEventLogRepository(this.db)
    this.claims = new SqliteClaimStore(this.db)
    this.usage = new SqliteUsageRepository(this.db, options.clock)
    this.config = new SqliteConfigRepository(this.db)
  }

  async migrate(): Promise<void> {
    migrate(this.db)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
