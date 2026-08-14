/**
 * Minimal shape of the Anthropic Messages API wire format — only the fields
 * this adapter reads or writes. Not an exhaustive SDK type set.
 */

export interface AnthropicTextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface AnthropicImageBlock {
  readonly type: 'image'
  readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string }
}

export interface AnthropicToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface AnthropicToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

export interface AnthropicThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  readonly type: 'redacted_thinking'
  readonly data: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock

export interface AnthropicMessage {
  readonly role: 'user' | 'assistant'
  readonly content: readonly AnthropicContentBlock[]
}

export interface AnthropicTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export interface AnthropicThinkingConfig {
  readonly type: 'enabled'
  readonly budget_tokens: number
}

export interface AnthropicRequestBody {
  readonly model: string
  readonly system?: string
  readonly messages: readonly AnthropicMessage[]
  readonly tools?: readonly AnthropicTool[]
  readonly max_tokens: number
  readonly temperature?: number
  readonly stop_sequences?: readonly string[]
  readonly thinking?: AnthropicThinkingConfig
  readonly stream?: boolean
}

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | null

export interface AnthropicUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

export interface AnthropicMessageResponse {
  readonly id: string
  readonly type: 'message'
  readonly role: 'assistant'
  readonly model: string
  readonly content: readonly AnthropicContentBlock[]
  readonly stop_reason: AnthropicStopReason
  readonly stop_sequence?: string | null
  readonly usage: AnthropicUsage
}

export interface AnthropicModelListEntry {
  readonly id: string
  readonly display_name?: string
  readonly created_at?: string
}

export interface AnthropicModelListResponse {
  readonly data: readonly AnthropicModelListEntry[]
}

// --- Streaming event payloads ---

export interface AnthropicMessageStartEvent {
  readonly type: 'message_start'
  readonly message: {
    readonly id: string
    readonly model: string
    readonly role: 'assistant'
    readonly usage: AnthropicUsage
  }
}

export interface AnthropicContentBlockStartEvent {
  readonly type: 'content_block_start'
  readonly index: number
  readonly content_block: AnthropicContentBlock
}

export type AnthropicContentBlockDelta =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly thinking: string }
  | { readonly type: 'signature_delta'; readonly signature: string }
  | { readonly type: 'input_json_delta'; readonly partial_json: string }

export interface AnthropicContentBlockDeltaEvent {
  readonly type: 'content_block_delta'
  readonly index: number
  readonly delta: AnthropicContentBlockDelta
}

export interface AnthropicContentBlockStopEvent {
  readonly type: 'content_block_stop'
  readonly index: number
}

export interface AnthropicMessageDeltaEvent {
  readonly type: 'message_delta'
  readonly delta: {
    readonly stop_reason?: AnthropicStopReason
    readonly stop_sequence?: string | null
  }
  readonly usage?: { readonly output_tokens?: number }
}

export interface AnthropicMessageStopEvent {
  readonly type: 'message_stop'
}

export interface AnthropicPingEvent {
  readonly type: 'ping'
}

export interface AnthropicErrorEvent {
  readonly type: 'error'
  readonly error: { readonly type: string; readonly message: string }
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent
