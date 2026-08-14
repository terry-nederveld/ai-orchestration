/**
 * Translation between the core neutral ModelRequest/ModelResponse shapes and
 * the Anthropic Messages API wire format.
 */

import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  StopReason,
  TokenUsage,
  ToolCallBlock,
} from '@overture/core'
import { OrchestratorError } from '@overture/core'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageResponse,
  AnthropicRequestBody,
  AnthropicStopReason,
  AnthropicThinkingConfig,
  AnthropicUsage,
} from './anthropic-types.js'

const REASONING_BUDGET_TOKENS: Record<'low' | 'medium' | 'high', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

const DEFAULT_MAX_TOKENS = 4096

function resolveThinking(request: ModelRequest): AnthropicThinkingConfig | undefined {
  const effort = request.reasoningEffort
  if (!effort || effort === 'none') return undefined
  return { type: 'enabled', budget_tokens: REASONING_BUDGET_TOKENS[effort] }
}

function resolveMaxTokens(
  request: ModelRequest,
  thinking: AnthropicThinkingConfig | undefined,
): number {
  const requested = request.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  if (!thinking) return requested
  return Math.max(requested, thinking.budget_tokens + 1024)
}

function toAnthropicBlock(block: ContentBlock): AnthropicContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      }
    case 'tool_call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content,
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
      }
    case 'thinking':
      // Anthropic requires the exact original block (including signature) to
      // replay a thinking block; without it we cannot reconstruct one, so we
      // drop it rather than send a block the API will reject.
      return block.raw as AnthropicContentBlock | undefined
    default:
      return undefined
  }
}

function toAnthropicRole(role: Message['role']): 'user' | 'assistant' | undefined {
  if (role === 'assistant') return 'assistant'
  if (role === 'user' || role === 'tool') return 'user'
  return undefined // 'system' messages are merged into the top-level system prompt
}

function extractSystemText(messages: readonly Message[]): string | undefined {
  const systemTexts = messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
  return systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined
}

export function toAnthropicMessages(messages: readonly Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = []
  for (const message of messages) {
    const role = toAnthropicRole(message.role)
    if (!role) continue
    const content = message.content
      .map(toAnthropicBlock)
      .filter((b): b is AnthropicContentBlock => b !== undefined)
    if (content.length === 0) continue
    result.push({ role, content })
  }
  return result
}

export function toAnthropicRequest(request: ModelRequest, stream: boolean): AnthropicRequestBody {
  const thinking = resolveThinking(request)
  const inlineSystem = extractSystemText(request.messages)
  const system =
    [request.system, inlineSystem].filter((s): s is string => !!s).join('\n\n') || undefined

  return {
    model: request.model,
    ...(system !== undefined ? { system } : {}),
    messages: toAnthropicMessages(request.messages),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }
      : {}),
    max_tokens: resolveMaxTokens(request, thinking),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stopSequences && request.stopSequences.length > 0
      ? { stop_sequences: request.stopSequences }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(stream ? { stream: true } : {}),
  }
}

export function fromAnthropicStopReason(reason: AnthropicStopReason): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export function fromAnthropicUsage(usage: AnthropicUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
      } satisfies ToolCallBlock
    case 'thinking':
      return { type: 'thinking', text: block.thinking, raw: block }
    case 'redacted_thinking':
      return { type: 'thinking', text: '', raw: block }
    case 'image':
    case 'tool_result':
      // Anthropic never emits these block types in a model *response*.
      return undefined
    default:
      return undefined
  }
}

export function fromAnthropicResponse(response: AnthropicMessageResponse): ModelResponse {
  const content = response.content
    .map(fromAnthropicBlock)
    .filter((b): b is ContentBlock => b !== undefined)
  return {
    model: response.model,
    content,
    stopReason: fromAnthropicStopReason(response.stop_reason),
    usage: fromAnthropicUsage(response.usage),
  }
}

export function parseToolInputJson(raw: string, toolName: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new OrchestratorError(
      `corrupt tool_use input JSON for tool "${toolName}": ${String(error)}`,
      'corrupt-response',
      {
        retryable: false,
        cause: error,
      },
    )
  }
}
