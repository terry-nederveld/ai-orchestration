/**
 * SQLite-backed `ConfigRepository`. Namespace + key form the primary key, so
 * a namespace is just a prefix filter — there's no separate namespace table.
 * Values are arbitrary JSON; callers must not store secrets here (see the
 * package-level note in the README / task description — this adapter has no
 * secret handling).
 */

import type { ConfigRepository } from '@overture/core'
import type { Database } from './database.js'

export class SqliteConfigRepository implements ConfigRepository {
  constructor(private readonly db: Database) {}

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const row = this.db.get<{ value: string }>(
      'SELECT value FROM config WHERE namespace = ? AND key = ?',
      [namespace, key],
    )
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    this.db.run(
      `INSERT INTO config (namespace, key, value) VALUES (?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`,
      [namespace, key, JSON.stringify(value)],
    )
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.db.run('DELETE FROM config WHERE namespace = ? AND key = ?', [namespace, key])
  }

  async list(namespace: string): Promise<Readonly<Record<string, unknown>>> {
    const rows = this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM config WHERE namespace = ?',
      [namespace],
    )
    const result: Record<string, unknown> = {}
    for (const row of rows) result[row.key] = JSON.parse(row.value)
    return result
  }
}
