/**
 * Pure translation between the Claude Agent SDK's streamed message shapes
 * and core's AgentEvent / AgentOutcome contracts. Kept free of SDK process
 * concerns (spawning, aborting) so it can be unit tested against scripted
 * message fixtures alone.
 */

import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentOutcome, TokenUsage, UsageRecord } from '@overture/core'

type AssistantContentBlock = SDKAssistantMessage['message']['content'][number]

/** Tracks toolCallId -> toolName so tool_result frames (which lack a name) can be reported. */
export class ToolNameTracker {
  private readonly names = new Map<string, string>()

  remember(toolCallId: string, toolName: string): void {
    this.names.set(toolCallId, toolName)
  }

  resolve(toolCallId: string): string {
    return this.names.get(toolCallId) ?? 'unknown'
  }
}

function isToolUseBlock(
  block: AssistantContentBlock,
): block is Extract<AssistantContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use'
}

/** Translates one SDKAssistantMessage into zero or more core AgentEvents. */
export function fromAssistantMessage(
  message: SDKAssistantMessage,
  tools: ToolNameTracker,
): AgentEvent[] {
  const events: AgentEvent[] = []
  const content = message.message.content
  if (!Array.isArray(content)) return events

  for (const block of content) {
    if (block.type === 'text') {
      events.push({ type: 'agent.text', text: block.text })
    } else if (block.type === 'thinking') {
      events.push({ type: 'agent.thinking', text: block.thinking })
    } else if (isToolUseBlock(block)) {
      tools.remember(block.id, block.name)
      events.push({
        type: 'agent.tool.started',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      })
    }
  }
  return events
}

function stringifyToolResultPart(part: unknown): string {
  if (part && typeof part === 'object' && 'text' in part)
    return String((part as { text: unknown }).text)
  return JSON.stringify(part)
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(stringifyToolResultPart).join('\n')
  return JSON.stringify(content ?? '')
}

/** Translates one SDKUserMessage (tool_result frames) into core AgentEvents. */
export function fromUserMessage(message: SDKUserMessage, tools: ToolNameTracker): AgentEvent[] {
  const events: AgentEvent[] = []
  const content = message.message.content
  if (!Array.isArray(content)) return events

  for (const block of content) {
    if (block.type === 'tool_result') {
      const toolCallId = block.tool_use_id
      events.push({
        type: 'agent.tool.completed',
        toolCallId,
        toolName: tools.resolve(toolCallId),
        isError: block.is_error === true,
        content: stringifyToolResultContent(block.content),
      })
    }
  }
  return events
}

/** Maps a terminal SDKResultMessage subtype to a core AgentOutcome. */
export function toAgentOutcome(result: SDKResultMessage): AgentOutcome {
  if (result.subtype === 'success') return 'GOAL_COMPLETED'
  if (result.subtype === 'error_max_turns') return 'BUDGET_EXHAUSTED'
  if (result.subtype === 'error_max_budget_usd') return 'BUDGET_EXHAUSTED'
  // error_during_execution, error_max_structured_output_retries, and any
  // future subtype default to a fatal failure: the run did not complete
  // its goal and no budget dimension was specifically exhausted.
  return 'FATAL_FAILURE'
}

function toTokenUsage(usage: SDKResultMessage['usage']): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  }
}

export function toUsageRecord(result: SDKResultMessage, model: string): UsageRecord {
  return {
    provider: 'claude-code',
    model,
    tokens: toTokenUsage(result.usage),
    estimatedCostUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
    turns: result.num_turns,
    subagents: 0,
  }
}

export function resultSummary(result: SDKResultMessage): string {
  if (result.subtype === 'success') return result.result
  if ('errors' in result && result.errors.length > 0) return result.errors.join('\n')
  return `Claude Code run ended: ${result.subtype}`
}
