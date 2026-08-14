/**
 * Pure translation between `codex exec --json` event shapes (codex-types.ts)
 * and core's AgentEvent / UsageRecord contracts.
 */

import type { AgentEvent, TokenUsage, UsageRecord } from '@overture/core'
import {
  type CodexItem,
  type CodexUsage,
  isAgentMessageItem,
  isCommandExecutionItem,
  isErrorItem,
  isFileChangeItem,
} from './codex-types.js'

/** Translates one item.started/item.completed payload into zero or more core AgentEvents. */
export function fromItemEvent(phase: 'started' | 'completed', item: CodexItem): AgentEvent[] {
  if (isAgentMessageItem(item)) {
    // Only the completed frame carries text; agent_message never has a
    // "started" phase in observed output.
    return phase === 'completed' ? [{ type: 'agent.text', text: item.text }] : []
  }

  if (isCommandExecutionItem(item)) {
    if (phase === 'started') {
      return [
        {
          type: 'agent.tool.started',
          toolCallId: item.id,
          toolName: 'command_execution',
          input: { command: item.command },
        },
      ]
    }
    return [
      {
        type: 'agent.tool.completed',
        toolCallId: item.id,
        toolName: 'command_execution',
        isError: item.exit_code !== 0,
        content: item.aggregated_output,
      },
    ]
  }

  if (isFileChangeItem(item)) {
    if (phase === 'started') {
      return [
        {
          type: 'agent.tool.started',
          toolCallId: item.id,
          toolName: 'file_change',
          input: { changes: item.changes },
        },
      ]
    }
    return [
      {
        type: 'agent.tool.completed',
        toolCallId: item.id,
        toolName: 'file_change',
        isError: false,
        content: JSON.stringify(item.changes),
      },
    ]
  }

  if (isErrorItem(item)) {
    // Advisory item-level errors (e.g. "model metadata not found, falling
    // back") are surfaced as text rather than dropped; turn-fatal failures
    // arrive separately via the top-level `error` / `turn.failed` events.
    return phase === 'completed' ? [{ type: 'agent.text', text: `[codex] ${item.message}` }] : []
  }

  // Forward-compat: unknown item kinds are reported generically rather than
  // silently dropped, so new codex item types stay observable.
  return [
    {
      type: phase === 'started' ? 'agent.tool.started' : 'agent.tool.completed',
      toolCallId: item.id,
      toolName: item.type,
      ...(phase === 'started'
        ? { input: item }
        : { isError: false, content: JSON.stringify(item) }),
    } as AgentEvent,
  ]
}

function toTokenUsage(usage: CodexUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
  }
}

/**
 * Builds a UsageRecord from the most recent turn.completed usage payload.
 * codex does not report a dollar cost in JSONL events, so estimatedCostUsd
 * is left unset; subscriptionRequests approximates one request per
 * completed turn, since ChatGPT-plan usage is billed as call volume, not
 * tokens.
 */
export function toUsageRecord(
  usage: CodexUsage,
  model: string,
  durationMs: number,
  turns: number,
): UsageRecord {
  return {
    provider: 'codex',
    model,
    tokens: toTokenUsage(usage),
    subscriptionRequests: turns,
    durationMs,
    turns,
    subagents: 0,
  }
}
