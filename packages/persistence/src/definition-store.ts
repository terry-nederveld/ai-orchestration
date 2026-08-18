/**
 * SQLite-backed `DefinitionStore` (ADR-0018). Versions are immutable and
 * content-addressed: `save` hashes the canonicalized document and returns
 * the existing latest version when nothing changed, otherwise mints
 * latest+1 — decided inside a transaction so two concurrent saves can't
 * mint the same version number. Lifecycle lives in its own per-(kind, name)
 * table and defaults to 'draft' when no row exists.
 */

import { createHash } from 'node:crypto'
import type {
  DefinitionKind,
  DefinitionLifecycle,
  DefinitionStatus,
  DefinitionStore,
  DefinitionVersion,
  ResolvedSnapshot,
} from '@overture/core'
import { type Clock, canonicalizeDocument, systemClock } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface DefinitionVersionRow extends Row {
  readonly kind: string
  readonly name: string
  readonly version: number
  readonly content_hash: string
  readonly document: string
  readonly created_at: string
}

interface StoredDefinitionVersion {
  readonly kind: DefinitionKind
  readonly name: string
  readonly version: number
  readonly contentHash: string
  readonly document: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

function rowToVersion(row: DefinitionVersionRow): DefinitionVersion {
  return {
    kind: row.kind as DefinitionKind,
    name: row.name,
    version: row.version,
    contentHash: row.content_hash,
    document: fromJson<Record<string, unknown>>(row.document),
    createdAt: new Date(row.created_at),
  }
}

export function contentHashOf(document: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalizeDocument(document)).digest('hex')
}

export class SqliteDefinitionStore implements DefinitionStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async save(
    kind: DefinitionKind,
    name: string,
    document: Readonly<Record<string, unknown>>,
  ): Promise<DefinitionVersion> {
    const contentHash = contentHashOf(document)
    return this.db.transaction(() => {
      const latest = this.db.get<DefinitionVersionRow>(
        'SELECT * FROM definition_versions WHERE kind = ? AND name = ? ORDER BY version DESC LIMIT 1',
        [kind, name],
      )
      if (latest && latest.content_hash === contentHash) return rowToVersion(latest)
      const version: DefinitionVersion = {
        kind,
        name,
        version: (latest?.version ?? 0) + 1,
        contentHash,
        document,
        createdAt: this.clock.now(),
      }
      this.db.run(
        `INSERT INTO definition_versions (kind, name, version, content_hash, document, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          kind,
          name,
          version.version,
          contentHash,
          toJson(document),
          version.createdAt.toISOString(),
        ],
      )
      this.db.run(
        'INSERT INTO definition_lifecycles (kind, name) VALUES (?, ?) ON CONFLICT(kind, name) DO NOTHING',
        [kind, name],
      )
      return version
    })
  }

  async get(
    kind: DefinitionKind,
    name: string,
    version?: number,
  ): Promise<DefinitionVersion | undefined> {
    const row =
      version !== undefined
        ? this.db.get<DefinitionVersionRow>(
            'SELECT * FROM definition_versions WHERE kind = ? AND name = ? AND version = ?',
            [kind, name, version],
          )
        : this.db.get<DefinitionVersionRow>(
            'SELECT * FROM definition_versions WHERE kind = ? AND name = ? ORDER BY version DESC LIMIT 1',
            [kind, name],
          )
    return row ? rowToVersion(row) : undefined
  }

  async list(kind: DefinitionKind): Promise<readonly DefinitionStatus[]> {
    return this.db
      .all<{ name: string; latest_version: number; lifecycle: string | null }>(
        `SELECT v.name AS name, MAX(v.version) AS latest_version, l.lifecycle AS lifecycle
         FROM definition_versions v
         LEFT JOIN definition_lifecycles l ON l.kind = v.kind AND l.name = v.name
         WHERE v.kind = ?
         GROUP BY v.name
         ORDER BY v.name`,
        [kind],
      )
      .map((row) => ({
        kind,
        name: row.name,
        lifecycle: (row.lifecycle ?? 'draft') as DefinitionLifecycle,
        latestVersion: row.latest_version,
      }))
  }

  async listVersions(kind: DefinitionKind, name: string): Promise<readonly DefinitionVersion[]> {
    return this.db
      .all<DefinitionVersionRow>(
        'SELECT * FROM definition_versions WHERE kind = ? AND name = ? ORDER BY version ASC',
        [kind, name],
      )
      .map(rowToVersion)
  }

  async setLifecycle(
    kind: DefinitionKind,
    name: string,
    lifecycle: DefinitionLifecycle,
  ): Promise<void> {
    this.db.run(
      `INSERT INTO definition_lifecycles (kind, name, lifecycle) VALUES (?, ?, ?)
       ON CONFLICT(kind, name) DO UPDATE SET lifecycle = excluded.lifecycle`,
      [kind, name, lifecycle],
    )
  }

  async getLifecycle(kind: DefinitionKind, name: string): Promise<DefinitionLifecycle> {
    const row = this.db.get<{ lifecycle: string }>(
      'SELECT lifecycle FROM definition_lifecycles WHERE kind = ? AND name = ?',
      [kind, name],
    )
    return (row?.lifecycle ?? 'draft') as DefinitionLifecycle
  }

  async saveSnapshot(snapshot: ResolvedSnapshot): Promise<void> {
    const definitions: StoredDefinitionVersion[] = snapshot.definitions.map((definition) => ({
      kind: definition.kind,
      name: definition.name,
      version: definition.version,
      contentHash: definition.contentHash,
      document: definition.document,
      createdAt: definition.createdAt.toISOString(),
    }))
    this.db.run(
      `INSERT INTO snapshots (id, root, definitions, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         root = excluded.root,
         definitions = excluded.definitions,
         created_at = excluded.created_at`,
      [snapshot.id, toJson(snapshot.root), toJson(definitions), snapshot.createdAt.toISOString()],
    )
  }

  async getSnapshot(id: string): Promise<ResolvedSnapshot | undefined> {
    const row = this.db.get<{ id: string; root: string; definitions: string; created_at: string }>(
      'SELECT * FROM snapshots WHERE id = ?',
      [id],
    )
    if (!row) return undefined
    return {
      id: row.id,
      root: fromJson<ResolvedSnapshot['root']>(row.root),
      definitions: fromJson<StoredDefinitionVersion[]>(row.definitions).map((definition) => ({
        ...definition,
        createdAt: new Date(definition.createdAt),
      })),
      createdAt: new Date(row.created_at),
    }
  }
}
