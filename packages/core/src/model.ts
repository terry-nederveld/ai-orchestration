/**
 * Model-provider contract: direct LLM inference behind a neutral message and
 * tool-call representation. Vendor SDK types never leak past an adapter.
 */

import type { TokenUsage } from './budget.js'
import type { CapabilitySet, ProviderAvailability, ProviderInfo } from './capabilities.js'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ImageBlock {
  readonly type: 'image'
  readonly mediaType: string
  /** Base64-encoded image data. */
  readonly data: string
}

export interface ToolCallBlock {
  readonly type: 'tool_call'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly toolCallId: string
  readonly content: string
  readonly isError?: boolean
}

export interface ThinkingBlock {
  readonly type: 'thinking'
  readonly text: string
  /** Opaque provider payload required to replay the block (e.g. signatures). */
  readonly raw?: unknown
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock | ThinkingBlock

export interface Message {
  readonly role: MessageRole
  readonly content: readonly ContentBlock[]
}

/** JSON-Schema-described tool exposed to a model. */
export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  readonly model: string
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolDescriptor[]
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly stopSequences?: readonly string[]
  /** Provider-neutral reasoning-effort hint; adapters map or ignore. */
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  readonly metadata?: Readonly<Record<string, string>>
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal'

export interface ModelResponse {
  readonly model: string
  readonly content: readonly ContentBlock[]
  readonly stopReason: StopReason
  readonly usage: TokenUsage
}

/** Incremental events emitted while streaming a model response. */
export type ModelStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly text: string }
  | { readonly type: 'tool_call_started'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_call_delta'; readonly id: string; readonly inputJsonDelta: string }
  | { readonly type: 'response'; readonly response: ModelResponse }

export interface ModelInfo {
  readonly id: string
  readonly displayName?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  /** USD per million tokens, when known. Used for cost estimation only. */
  readonly inputCostPerMTok?: number
  readonly outputCostPerMTok?: number
}

export interface ModelProvider {
  readonly info: ProviderInfo
  capabilities(model?: string): CapabilitySet
  detect(): Promise<ProviderAvailability>
  listModels(): Promise<readonly ModelInfo[]>
  /** Single-shot completion. Must respect the abort signal. */
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
  /**
   * Streaming completion. The final event is always `response`. Providers
   * without native streaming may emulate it by yielding the completed
   * response as a single event pair.
   */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>
}

/** Collect a stream into its terminal response. */
export async function collectResponse(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined
  for await (const event of stream) {
    if (event.type === 'response') response = event.response
  }
  if (!response) throw new Error('model stream ended without a terminal response event')
  return response
}
