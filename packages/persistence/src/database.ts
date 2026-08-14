/**
 * Thin synchronous wrapper around node:sqlite's `DatabaseSync`. Node's
 * built-in SQLite binding requires no native npm dependency, so this adapter
 * has a zero-native-dependency footprint across platforms.
 *
 * `DatabaseSync` calls are synchronous and Node is single-threaded, so a
 * single connection never interleaves two callers mid-statement; the async
 * `PersistenceProvider` port is satisfied by wrapping synchronous work in
 * resolved promises rather than needing its own locking.
 */

import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite'

export type SqlParams = readonly SQLInputValue[]

/** Row shape returned by node:sqlite: a null-prototype object of columns. */
export type Row = Record<string, unknown>

export class Database {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // WAL is a no-op (falls back to "memory") for :memory: databases but is
    // harmless to request unconditionally.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: SqlParams = []): StatementResultingChanges {
    return this.db.prepare(sql).run(...params)
  }

  get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  all<T = Row>(sql: string, params: SqlParams = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
