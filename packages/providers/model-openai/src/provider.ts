/**
 * OpenAIModelProvider: ModelProvider backed by raw fetch against the OpenAI
 * Chat Completions API (POST {baseUrl}/chat/completions). Deliberately
 * targets Chat Completions rather than the Responses API so the same
 * adapter can serve any OpenAI-compatible endpoint (OpenRouter, Ollama,
 * vLLM, ...). No vendor SDK dependency.
 */

import {
  Capability,
  CapabilitySet,
  type ConsumptionModel,
  type ContentBlock,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ProviderAvailability,
  type ProviderInfo,
  type TokenUsage,
  type ToolCallBlock,
} from '@overture/core'
import {
  isAbortError,
  mapHttpErrorResponse,
  mapNetworkError,
  throwIfAborted,
} from './http-errors.js'
import {
  fromOpenAiFinishReason,
  fromOpenAiResponse,
  fromOpenAiUsage,
  parseToolCallArguments,
  toOpenAiRequest,
} from './mapping.js'
import type {
  OpenAiChatCompletionChunk,
  OpenAiChatCompletionResponse,
  OpenAiFinishReason,
  OpenAiModelListResponse,
} from './openai-types.js'
import { parseSse } from './sse.js'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface OpenAIModelProviderOptions {
  /** Stable machine identifier. Defaults to 'openai'. */
  readonly id?: string
  readonly displayName?: string
  /** Async resolver so the API key stays in the secret store, not memory longer than needed. */
  readonly apiKey: () => Promise<string | undefined>
  readonly baseUrl?: string
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Whether this endpoint requires an API key to be usable. Defaults to true. */
  readonly requiresAuth?: boolean
  /** Billing model advertised in provider info. Defaults to 'api-usage'. */
  readonly consumption?: ConsumptionModel
}

export class OpenAIModelProvider implements ModelProvider {
  readonly info: ProviderInfo

  private readonly apiKeyResolver: () => Promise<string | undefined>
  private readonly baseUrl: string
  private readonly defaultHeaders: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private readonly requiresAuth: boolean

  constructor(options: OpenAIModelProviderOptions) {
    this.apiKeyResolver = options.apiKey
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.defaultHeaders = options.defaultHeaders ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requiresAuth = options.requiresAuth ?? true
    this.info = {
      id: options.id ?? 'openai',
      displayName: options.displayName ?? 'OpenAI',
      kind: 'model',
      consumption: options.consumption ?? 'api-usage',
      authentication: this.requiresAuth ? ['api-key'] : ['none'],
    }
  }

  capabilities(): CapabilitySet {
    return CapabilitySet.of(
      Capability.Chat,
      Capability.ToolUse,
      Capability.ParallelToolUse,
      Capability.Vision,
      Capability.Streaming,
      Capability.Reasoning,
      Capability.StructuredOutput,
    )
  }

  async detect(): Promise<ProviderAvailability> {
    if (this.requiresAuth) {
      const key = await this.apiKeyResolver()
      if (!key) {
        return {
          installed: true,
          authenticated: false,
          available: false,
          authenticationKind: 'api-key',
          detail: `no API key configured for ${this.info.displayName}`,
        }
      }
    }
    try {
      const models = await this.listModels()
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: this.requiresAuth ? 'api-key' : 'none',
        models: models.map((m) => m.id),
      }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: this.requiresAuth ? 'api-key' : 'none',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const response = await this.rawFetch('/models', { method: 'GET' })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const body = (await response.json()) as OpenAiModelListResponse
    return body.data.map((entry) => ({ id: entry.id }))
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    throwIfAborted(signal)
    const body = toOpenAiRequest(request, false)
    const response = await this.rawFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const parsed = (await response.json()) as OpenAiChatCompletionResponse
    return fromOpenAiResponse(parsed)
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    throwIfAborted(signal)
    const body = toOpenAiRequest(request, true)
    const response = await this.rawFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    if (!response.body) throw new Error('OpenAI streaming response had no body')

    yield* this.consumeStream(response.body, request.model, signal)
  }

  private async *consumeStream(
    body: AsyncIterable<Uint8Array>,
    fallbackModel: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ModelStreamEvent> {
    let model = fallbackModel
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let finishReason: OpenAiFinishReason = null
    let textAccum = ''

    interface ToolCallAccum {
      id?: string
      name?: string
      arguments: string
      started: boolean
    }
    const toolCalls = new Map<number, ToolCallAccum>()

    for await (const event of parseSse(body)) {
      throwIfAborted(signal)
      if (event.data === '[DONE]') break
      const chunk = JSON.parse(event.data) as OpenAiChatCompletionChunk

      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)

      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta
      if (delta?.content) {
        textAccum += delta.content
        yield { type: 'text_delta', text: delta.content }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = toolCalls.get(tc.index)
          if (!entry) {
            entry = { arguments: '', started: false }
            toolCalls.set(tc.index, entry)
          }
          if (tc.id !== undefined) entry.id = tc.id
          if (tc.function?.name !== undefined) entry.name = tc.function.name
          if (!entry.started && entry.id !== undefined && entry.name !== undefined) {
            entry.started = true
            yield { type: 'tool_call_started', id: entry.id, name: entry.name }
          }
          if (tc.function?.arguments) {
            entry.arguments += tc.function.arguments
            if (entry.started && entry.id !== undefined) {
              yield { type: 'tool_call_delta', id: entry.id, inputJsonDelta: tc.function.arguments }
            }
          }
        }
      }
      throwIfAborted(signal)
    }

    const content: ContentBlock[] = []
    if (textAccum) content.push({ type: 'text', text: textAccum })
    for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      if (entry.id === undefined || entry.name === undefined) continue
      const toolCall: ToolCallBlock = {
        type: 'tool_call',
        id: entry.id,
        name: entry.name,
        input: parseToolCallArguments(entry.arguments, entry.name),
      }
      content.push(toolCall)
    }

    yield {
      type: 'response',
      response: { model, content, stopReason: fromOpenAiFinishReason(finishReason), usage },
    }
  }

  private async rawFetch(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const key = await this.apiKeyResolver()
    const headers: Record<string, string> = { ...this.defaultHeaders }
    if (key) headers.authorization = `Bearer ${key}`
    if (init.body) headers['content-type'] = 'application/json'

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw mapNetworkError(error)
    }
  }
}
