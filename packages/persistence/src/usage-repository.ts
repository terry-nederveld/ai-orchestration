/**
 * SQLite-backed `UsageRepository`. `UsageRecord` itself carries no
 * timestamp, so each recorded row is stamped with the injected clock (real
 * time by default, fake in tests) to support period-bounded queries.
 */

import type { RunId, UsageRecord, UsageRepository } from '@overture/core'
import { type Clock, systemClock } from '@overture/core'
import type { Database, Row } from './database.js'

interface UsageRow extends Row {
  readonly run_id: string
  readonly recorded_at: string
  readonly provider: string
  readonly model: string | null
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number | null
  readonly cache_write_tokens: number | null
  readonly estimated_cost_usd: number | null
  readonly subscription_requests: number | null
  readonly duration_ms: number
  readonly turns: number
  readonly subagents: number
}

function rowToUsageRecord(row: UsageRow): UsageRecord {
  return {
    provider: row.provider,
    ...(row.model != null ? { model: row.model } : {}),
    tokens: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      ...(row.cache_read_tokens != null ? { cacheReadTokens: row.cache_read_tokens } : {}),
      ...(row.cache_write_tokens != null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
    },
    ...(row.estimated_cost_usd != null ? { estimatedCostUsd: row.estimated_cost_usd } : {}),
    ...(row.subscription_requests != null
      ? { subscriptionRequests: row.subscription_requests }
      : {}),
    durationMs: row.duration_ms,
    turns: row.turns,
    subagents: row.subagents,
  }
}

export class SqliteUsageRepository implements UsageRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(runId: RunId, usage: UsageRecord): Promise<void> {
    this.db.run(
      `INSERT INTO usage_records (
         run_id, recorded_at, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, estimated_cost_usd,
         subscription_requests, duration_ms, turns, subagents
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        this.clock.now().toISOString(),
        usage.provider,
        usage.model ?? null,
        usage.tokens.inputTokens,
        usage.tokens.outputTokens,
        usage.tokens.cacheReadTokens ?? null,
        usage.tokens.cacheWriteTokens ?? null,
        usage.estimatedCostUsd ?? null,
        usage.subscriptionRequests ?? null,
        usage.durationMs,
        usage.turns,
        usage.subagents,
      ],
    )
  }

  async totalsForPeriod(periodStart: Date, periodEnd: Date): Promise<readonly UsageRecord[]> {
    return this.db
      .all<UsageRow>(
        'SELECT * FROM usage_records WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC',
        [periodStart.toISOString(), periodEnd.toISOString()],
      )
      .map(rowToUsageRecord)
  }
}
