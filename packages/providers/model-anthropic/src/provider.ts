/**
 * AnthropicModelProvider: ModelProvider backed by raw fetch against the
 * Anthropic Messages API. No vendor SDK dependency, so error mapping and
 * streaming parsing are fully under our control.
 */

import {
  Capability,
  CapabilitySet,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ProviderAvailability,
  type ProviderInfo,
  type TokenUsage,
} from '@overture/core'
import type {
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicModelListResponse,
  AnthropicStreamEvent,
} from './anthropic-types.js'
import {
  isAbortError,
  mapHttpErrorResponse,
  mapNetworkError,
  throwIfAborted,
} from './http-errors.js'
import {
  fromAnthropicResponse,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  parseToolInputJson,
  toAnthropicRequest,
} from './mapping.js'
import { parseSse } from './sse.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

export interface AnthropicModelProviderOptions {
  /** Async resolver so the API key stays in the secret store, not memory longer than needed. */
  readonly apiKey: () => Promise<string | undefined>
  readonly baseUrl?: string
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
}

export class AnthropicModelProvider implements ModelProvider {
  readonly info: ProviderInfo = {
    id: 'anthropic',
    displayName: 'Anthropic',
    kind: 'model',
    consumption: 'api-usage',
    authentication: ['api-key'],
  }

  private readonly apiKeyResolver: () => Promise<string | undefined>
  private readonly baseUrl: string
  private readonly defaultHeaders: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch

  constructor(options: AnthropicModelProviderOptions) {
    this.apiKeyResolver = options.apiKey
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.defaultHeaders = options.defaultHeaders ?? {}
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  capabilities(): CapabilitySet {
    return CapabilitySet.of(
      Capability.Chat,
      Capability.ToolUse,
      Capability.ParallelToolUse,
      Capability.Vision,
      Capability.Streaming,
      Capability.LongContext,
      Capability.Reasoning,
      Capability.StructuredOutput,
    )
  }

  async detect(): Promise<ProviderAvailability> {
    const key = await this.apiKeyResolver()
    if (!key) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'api-key',
        detail: 'no Anthropic API key configured',
      }
    }
    try {
      const models = await this.listModels()
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: 'api-key',
        models: models.map((m) => m.id),
      }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'api-key',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const response = await this.rawFetch('/models', { method: 'GET' })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const body = (await response.json()) as AnthropicModelListResponse
    return body.data.map((entry) => ({
      id: entry.id,
      ...(entry.display_name !== undefined ? { displayName: entry.display_name } : {}),
    }))
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    throwIfAborted(signal)
    const body = toAnthropicRequest(request, false)
    const response = await this.rawFetch('/messages', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const parsed = (await response.json()) as AnthropicMessageResponse
    return fromAnthropicResponse(parsed)
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    throwIfAborted(signal)
    const body = toAnthropicRequest(request, true)
    const response = await this.rawFetch('/messages', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    if (!response.body) throw new Error('Anthropic streaming response had no body')

    yield* this.consumeStream(response.body, request.model, signal)
  }

  private async *consumeStream(
    body: AsyncIterable<Uint8Array>,
    fallbackModel: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ModelStreamEvent> {
    let model = fallbackModel
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let stopReason: AnthropicMessageResponse['stop_reason'] = null

    const blocks = new Map<
      number,
      { block: AnthropicContentBlock; text: string; inputJson: string; signature: string }
    >()

    for await (const event of parseSse(body)) {
      throwIfAborted(signal)
      const parsed = JSON.parse(event.data) as AnthropicStreamEvent

      switch (parsed.type) {
        case 'message_start': {
          model = parsed.message.model
          usage = fromAnthropicUsage(parsed.message.usage)
          break
        }
        case 'content_block_start': {
          blocks.set(parsed.index, {
            block: parsed.content_block,
            text: '',
            inputJson: '',
            signature: '',
          })
          if (parsed.content_block.type === 'tool_use') {
            yield {
              type: 'tool_call_started',
              id: parsed.content_block.id,
              name: parsed.content_block.name,
            }
          }
          break
        }
        case 'content_block_delta': {
          const entry = blocks.get(parsed.index)
          if (!entry) break
          if (parsed.delta.type === 'text_delta') {
            entry.text += parsed.delta.text
            yield { type: 'text_delta', text: parsed.delta.text }
          } else if (parsed.delta.type === 'thinking_delta') {
            entry.text += parsed.delta.thinking
            yield { type: 'thinking_delta', text: parsed.delta.thinking }
          } else if (parsed.delta.type === 'signature_delta') {
            entry.signature += parsed.delta.signature
          } else if (parsed.delta.type === 'input_json_delta') {
            entry.inputJson += parsed.delta.partial_json
            if (entry.block.type === 'tool_use') {
              yield {
                type: 'tool_call_delta',
                id: entry.block.id,
                inputJsonDelta: parsed.delta.partial_json,
              }
            }
          }
          break
        }
        case 'content_block_stop': {
          const entry = blocks.get(parsed.index)
          if (entry && entry.block.type === 'tool_use') {
            entry.block = {
              ...entry.block,
              input: parseToolInputJson(entry.inputJson, entry.block.name),
            }
          } else if (entry && entry.block.type === 'thinking') {
            entry.block = {
              type: 'thinking',
              thinking: entry.text,
              ...(entry.signature ? { signature: entry.signature } : {}),
            }
          } else if (entry && entry.block.type === 'text') {
            entry.block = { type: 'text', text: entry.text }
          }
          break
        }
        case 'message_delta': {
          if (parsed.delta.stop_reason !== undefined) stopReason = parsed.delta.stop_reason
          if (parsed.usage?.output_tokens !== undefined) {
            usage = { ...usage, outputTokens: parsed.usage.output_tokens }
          }
          break
        }
        case 'message_stop': {
          const anthropicContent = [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, entry]) => entry.block)
          const { content } = fromAnthropicResponse({
            id: '',
            type: 'message',
            role: 'assistant',
            model,
            content: anthropicContent,
            stop_reason: stopReason,
            usage: { input_tokens: 0, output_tokens: 0 },
          })
          yield {
            type: 'response',
            response: { model, content, stopReason: fromAnthropicStopReason(stopReason), usage },
          }
          return
        }
        case 'error': {
          throw new Error(`Anthropic stream error (${parsed.error.type}): ${parsed.error.message}`)
        }
        case 'ping':
          break
        default:
          break
      }
    }
  }

  private async rawFetch(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const key = await this.apiKeyResolver()
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.defaultHeaders,
    }
    if (key) headers['x-api-key'] = key
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
