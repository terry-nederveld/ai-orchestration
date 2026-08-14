/**
 * ScriptedModelProvider: a deterministic ModelProvider fake driven by an
 * ordered script of turns. Every request/response shape mirrors what a real
 * adapter would produce so orchestration code under test cannot tell the
 * difference except by asking for capabilities the script doesn't have.
 */

import {
  Capability,
  CapabilitySet,
  type ContentBlock,
  type ErrorCategory,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  OrchestratorError,
  type ProviderAvailability,
  type ProviderInfo,
  type StopReason,
  type TokenUsage,
  type ToolCallBlock,
} from '@overture/core'

export interface ScriptedToolCall {
  readonly name: string
  readonly input: unknown
  readonly id?: string
}

export type ScriptedTurn =
  | { readonly kind: 'text'; readonly text: string; readonly usage?: TokenUsage }
  | ({
      readonly kind: 'tool_call'
      readonly usage?: TokenUsage
      readonly additionalCalls?: readonly ScriptedToolCall[]
    } & ScriptedToolCall)
  | { readonly kind: 'fail'; readonly error: string; readonly category?: ErrorCategory }
  | { readonly kind: 'timeout'; readonly afterMs?: number }
  | { readonly kind: 'max_tokens'; readonly text: string; readonly usage?: TokenUsage }

export interface ScriptedModelProviderOptions {
  readonly info?: Partial<ProviderInfo>
  readonly capabilities?: CapabilitySet
  readonly models?: readonly ModelInfo[]
  readonly availability?: Partial<ProviderAvailability>
  readonly defaultUsage?: TokenUsage
  /** Character count per streamed delta chunk. Defaults to 12. */
  readonly streamChunkSize?: number
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 }

function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return []
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

/** A "fail"/"timeout" turn, narrowed for internal dispatch. */
type TerminatingTurn = Extract<ScriptedTurn, { kind: 'fail' | 'timeout' }>
type ContentTurn = Exclude<ScriptedTurn, TerminatingTurn>

export class ScriptedModelProvider implements ModelProvider {
  readonly info: ProviderInfo
  /** Every ModelRequest received, in order, for assertions. */
  readonly requests: ModelRequest[] = []

  private readonly script: ScriptedTurn[]
  private readonly capabilitySet: CapabilitySet
  private readonly models: readonly ModelInfo[]
  private readonly availability: ProviderAvailability
  private readonly defaultUsage: TokenUsage
  private readonly streamChunkSize: number
  private callSeq = 0

  constructor(script: readonly ScriptedTurn[], options: ScriptedModelProviderOptions = {}) {
    this.script = [...script]
    this.info = {
      id: 'scripted-model',
      displayName: 'Scripted Model Provider',
      kind: 'model',
      consumption: 'local',
      authentication: ['none'],
      ...options.info,
    }
    this.capabilitySet =
      options.capabilities ??
      CapabilitySet.of(Capability.Chat, Capability.ToolUse, Capability.Streaming)
    this.models = options.models ?? [{ id: 'scripted-model', displayName: 'Scripted Model' }]
    this.availability = {
      installed: true,
      authenticated: true,
      available: true,
      models: this.models.map((m) => m.id),
      ...options.availability,
    }
    this.defaultUsage = options.defaultUsage ?? DEFAULT_USAGE
    this.streamChunkSize = options.streamChunkSize ?? 12
  }

  capabilities(): CapabilitySet {
    return this.capabilitySet
  }

  async detect(): Promise<ProviderAvailability> {
    return this.availability
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) })
    this.throwIfAborted(signal)
    const turn = this.nextTurn()
    return this.resolve(turn, request, signal)
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) })
    this.throwIfAborted(signal)
    const turn = this.nextTurn()
    if (this.isTerminating(turn)) {
      await this.resolve(turn, request, signal) // always throws
      return
    }

    const response = this.buildResponse(turn, request)
    for (const block of response.content) {
      this.throwIfAborted(signal)
      if (block.type === 'text') {
        for (const chunk of chunkText(block.text, this.streamChunkSize)) {
          this.throwIfAborted(signal)
          yield { type: 'text_delta', text: chunk }
        }
      } else if (block.type === 'tool_call') {
        yield { type: 'tool_call_started', id: block.id, name: block.name }
        for (const chunk of chunkText(JSON.stringify(block.input ?? {}), this.streamChunkSize)) {
          this.throwIfAborted(signal)
          yield { type: 'tool_call_delta', id: block.id, inputJsonDelta: chunk }
        }
      }
    }
    yield { type: 'response', response }
  }

  private isTerminating(turn: ScriptedTurn): turn is TerminatingTurn {
    return turn.kind === 'fail' || turn.kind === 'timeout'
  }

  private nextTurn(): ScriptedTurn {
    const turn = this.script.shift()
    if (!turn) {
      throw new Error(
        `ScriptedModelProvider [${this.info.id}]: script exhausted after ${this.requests.length} request(s)`,
      )
    }
    return turn
  }

  private async resolve(
    turn: ScriptedTurn,
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (turn.kind === 'fail') {
      throw new OrchestratorError(turn.error, turn.category ?? 'internal')
    }
    if (turn.kind === 'timeout') {
      await this.wait(turn.afterMs ?? 50, signal)
      throw new OrchestratorError('scripted model timed out', 'timeout', { retryable: true })
    }
    return this.buildResponse(turn, request)
  }

  private buildResponse(turn: ContentTurn, request: ModelRequest): ModelResponse {
    const usage = turn.usage ?? this.defaultUsage
    if (turn.kind === 'text') {
      return this.response(request, [{ type: 'text', text: turn.text }], 'end_turn', usage)
    }
    if (turn.kind === 'max_tokens') {
      return this.response(request, [{ type: 'text', text: turn.text }], 'max_tokens', usage)
    }
    const calls: ScriptedToolCall[] = [
      { name: turn.name, input: turn.input, ...(turn.id !== undefined ? { id: turn.id } : {}) },
      ...(turn.additionalCalls ?? []),
    ]
    const content: ToolCallBlock[] = calls.map((call) => ({
      type: 'tool_call',
      id: call.id ?? `call-${++this.callSeq}`,
      name: call.name,
      input: call.input,
    }))
    return this.response(request, content, 'tool_use', usage)
  }

  private response(
    request: ModelRequest,
    content: readonly ContentBlock[],
    stopReason: StopReason,
    usage: TokenUsage,
  ): ModelResponse {
    return { model: request.model, content, stopReason, usage }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortError(signal)
  }

  private abortError(signal: AbortSignal): OrchestratorError {
    return new OrchestratorError('scripted model request aborted', 'internal', {
      retryable: false,
      cause: signal.reason,
    })
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(this.abortError(signal))
        return
      }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(this.abortError(signal))
        },
        { once: true },
      )
    })
  }
}
