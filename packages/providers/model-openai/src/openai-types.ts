/**
 * Minimal shape of the OpenAI Chat Completions API wire format — only the
 * fields this adapter reads or writes. Deliberately loose enough to also
 * cover OpenAI-compatible servers (OpenRouter, Ollama, vLLM, ...).
 */

export type OpenAiRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface OpenAiTextPart {
  readonly type: 'text'
  readonly text: string
}

export interface OpenAiImagePart {
  readonly type: 'image_url'
  readonly image_url: { readonly url: string }
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart

export interface OpenAiToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

export interface OpenAiMessage {
  readonly role: OpenAiRole
  readonly content?: string | readonly OpenAiContentPart[] | null
  readonly tool_calls?: readonly OpenAiToolCall[]
  readonly tool_call_id?: string
  readonly name?: string
}

export interface OpenAiFunctionTool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

export interface OpenAiRequestBody {
  readonly model: string
  readonly messages: readonly OpenAiMessage[]
  readonly tools?: readonly OpenAiFunctionTool[]
  readonly max_tokens?: number
  readonly temperature?: number
  readonly stop?: readonly string[]
  readonly reasoning_effort?: 'low' | 'medium' | 'high'
  readonly stream?: boolean
  readonly stream_options?: { readonly include_usage: boolean }
}

export type OpenAiFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'function_call'
  | null

export interface OpenAiUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens?: number
  readonly prompt_tokens_details?: { readonly cached_tokens?: number }
}

export interface OpenAiChoiceMessage {
  readonly role: 'assistant'
  readonly content?: string | null
  readonly tool_calls?: readonly OpenAiToolCall[]
}

export interface OpenAiChatCompletionResponse {
  readonly id: string
  readonly model: string
  readonly choices: readonly {
    readonly index: number
    readonly message: OpenAiChoiceMessage
    readonly finish_reason: OpenAiFinishReason
  }[]
  readonly usage?: OpenAiUsage
}

export interface OpenAiModelListEntry {
  readonly id: string
  readonly owned_by?: string
}

export interface OpenAiModelListResponse {
  readonly data: readonly OpenAiModelListEntry[]
}

// --- Streaming chunk payloads ---

export interface OpenAiToolCallDelta {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

export interface OpenAiChunkDelta {
  readonly role?: 'assistant'
  readonly content?: string | null
  readonly tool_calls?: readonly OpenAiToolCallDelta[]
}

export interface OpenAiChatCompletionChunk {
  readonly id?: string
  readonly model?: string
  readonly choices: readonly {
    readonly index: number
    readonly delta: OpenAiChunkDelta
    readonly finish_reason?: OpenAiFinishReason
  }[]
  readonly usage?: OpenAiUsage
}
