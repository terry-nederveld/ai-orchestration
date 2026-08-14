/**
 * SQLite-backed `SessionRepository`. Message history is stored as a JSON
 * snapshot per session rather than modeled relationally — sessions are
 * replaced wholesale on save, not appended to incrementally.
 */

import type { Message, SessionRepository, SessionSnapshot } from '@overture/core'
import { asId, type RunId, type SessionId } from '@overture/core'
import type { Database, Row } from './database.js'
import { fromJson, toJson } from './serde.js'

interface SessionRow extends Row {
  readonly session_id: string
  readonly run_id: string
  readonly provider: string
  readonly model: string | null
  readonly system_prompt: string | null
  readonly messages: string
  readonly provider_session_id: string | null
  readonly updated_at: string
}

function rowToSnapshot(row: SessionRow): SessionSnapshot {
  return {
    sessionId: asId<'session'>(row.session_id),
    runId: asId<'run'>(row.run_id),
    provider: row.provider,
    ...(row.model != null ? { model: row.model } : {}),
    ...(row.system_prompt != null ? { systemPrompt: row.system_prompt } : {}),
    messages: fromJson<Message[]>(row.messages),
    ...(row.provider_session_id != null ? { providerSessionId: row.provider_session_id } : {}),
    updatedAt: new Date(row.updated_at),
  }
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.db.run(
      `INSERT INTO sessions (
         session_id, run_id, provider, model, system_prompt, messages,
         provider_session_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         run_id = excluded.run_id,
         provider = excluded.provider,
         model = excluded.model,
         system_prompt = excluded.system_prompt,
         messages = excluded.messages,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at`,
      [
        snapshot.sessionId,
        snapshot.runId,
        snapshot.provider,
        snapshot.model ?? null,
        snapshot.systemPrompt ?? null,
        toJson(snapshot.messages),
        snapshot.providerSessionId ?? null,
        snapshot.updatedAt.toISOString(),
      ],
    )
  }

  async get(id: SessionId): Promise<SessionSnapshot | undefined> {
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE session_id = ?', [id])
    return row ? rowToSnapshot(row) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly SessionSnapshot[]> {
    return this.db
      .all<SessionRow>('SELECT * FROM sessions WHERE run_id = ? ORDER BY updated_at ASC', [runId])
      .map(rowToSnapshot)
  }
}
