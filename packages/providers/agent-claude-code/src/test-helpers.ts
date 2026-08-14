/** Scripted SDK message + fake `query()` builders shared across this package's tests. No real CLI spawned. */

import { randomUUID } from 'node:crypto'
import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/** Builds a minimal SDKAssistantMessage carrying the given content blocks. Only the fields the mapping layer reads are filled; the rest are cast through. */
export function assistantMessage(content: unknown[]): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: 'session-1',
  } as unknown as SDKAssistantMessage
}

/** Builds a minimal SDKUserMessage carrying the given content blocks (typically tool_result frames). */
export function userMessage(content: unknown[]): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: 'session-1',
  } as unknown as SDKUserMessage
}

export function textBlock(text: string) {
  return { type: 'text' as const, text }
}

export function thinkingBlock(thinking: string) {
  return { type: 'thinking' as const, thinking }
}

export function toolUseBlock(id: string, name: string, input: unknown) {
  return { type: 'tool_use' as const, id, name, input }
}

export function toolResultBlock(toolUseId: string, content: unknown, isError = false) {
  return { type: 'tool_result' as const, tool_use_id: toolUseId, content, is_error: isError }
}

const baseUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

export function resultSuccess(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 2,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.05,
    usage: baseUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'session-1',
    ...overrides,
  } as unknown as SDKResultSuccess
}

export function resultError(
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries',
  overrides: Partial<SDKResultError> = {},
): SDKResultError {
  return {
    type: 'result',
    subtype,
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: baseUsage,
    modelUsage: {},
    permission_denials: [],
    errors: ['something went wrong'],
    uuid: randomUUID(),
    session_id: 'session-1',
    ...overrides,
  } as unknown as SDKResultError
}

export interface FakeQueryCall {
  readonly prompt: string | AsyncIterable<unknown>
  readonly options: Options | undefined
}

/**
 * A scripted `query()` replacement: yields the given messages in order, then
 * ends. `close()` truncates iteration immediately, simulating cancel/timeout.
 */
export function fakeQuery(
  messages: readonly SDKMessage[],
  calls: FakeQueryCall[] = [],
): typeof import('@anthropic-ai/claude-agent-sdk').query {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ prompt: params.prompt, options: params.options })
    let index = 0
    let closed = false

    const generator = {
      async next(): Promise<IteratorResult<SDKMessage, void>> {
        if (closed || index >= messages.length) return { value: undefined, done: true }
        const value = messages[index++]
        if (value === undefined) return { value: undefined, done: true }
        return { value, done: false }
      },
      async return(): Promise<IteratorResult<SDKMessage, void>> {
        closed = true
        return { value: undefined, done: true }
      },
      async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
        closed = true
        throw error
      },
      [Symbol.asyncIterator]() {
        return generator
      },
    }

    return Object.assign(generator, {
      close: () => {
        closed = true
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => {},
      setMcpPermissionModeOverride: async () => ({}),
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: [] }),
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      toggleMcpServer: async () => {},
    }) as unknown as Query
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
}

/** A fake query() whose generator never yields and never resolves until close() is called externally. */
export function hangingQuery(calls: FakeQueryCall[] = []): {
  readonly impl: typeof import('@anthropic-ai/claude-agent-sdk').query
  close: () => void
} {
  let closeFn = () => {}
  const impl = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ prompt: params.prompt, options: params.options })
    let closed = false
    let resolvePending: ((result: IteratorResult<SDKMessage, void>) => void) | undefined

    closeFn = () => {
      closed = true
      resolvePending?.({ value: undefined, done: true })
    }

    const generator = {
      next(): Promise<IteratorResult<SDKMessage, void>> {
        if (closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          resolvePending = resolve
        })
      },
      async return(): Promise<IteratorResult<SDKMessage, void>> {
        closed = true
        return { value: undefined, done: true }
      },
      async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
        closed = true
        throw error
      },
      [Symbol.asyncIterator]() {
        return generator
      },
    }

    return Object.assign(generator, {
      close: () => closeFn(),
      interrupt: async () => undefined,
      setPermissionMode: async () => {},
      setMcpPermissionModeOverride: async () => ({}),
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: [] }),
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      toggleMcpServer: async () => {},
    }) as unknown as Query
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query

  return {
    impl,
    close: () => closeFn(),
  }
}

/**
 * A fake `query()` whose generator only yields messages explicitly pushed
 * to it, and only ends when `end()` is called (or the provider calls
 * `close()`, e.g. from `cancel()`). Unlike `fakeQuery`, nothing happens
 * until driven — used by the AgentProvider contract suite so the
 * cancel-before-completion test races a real cancel() against a fake that
 * cannot resolve on its own.
 */
export function controllableQuery(calls: FakeQueryCall[] = []): {
  readonly impl: typeof import('@anthropic-ai/claude-agent-sdk').query
  push: (message: SDKMessage) => void
  end: () => void
} {
  const buffer: SDKMessage[] = []
  const waiters: Array<(result: IteratorResult<SDKMessage, void>) => void> = []
  let closed = false

  const push = (message: SDKMessage) => {
    if (closed) return
    const waiter = waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else buffer.push(message)
  }
  const end = () => {
    closed = true
    while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true })
  }

  const impl = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ prompt: params.prompt, options: params.options })

    const generator = {
      next(): Promise<IteratorResult<SDKMessage, void>> {
        const value = buffer.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => waiters.push(resolve))
      },
      async return(): Promise<IteratorResult<SDKMessage, void>> {
        end()
        return { value: undefined, done: true }
      },
      async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
        end()
        throw error
      },
      [Symbol.asyncIterator]() {
        return generator
      },
    }

    return Object.assign(generator, {
      close: () => end(),
      interrupt: async () => undefined,
      setPermissionMode: async () => {},
      setMcpPermissionModeOverride: async () => ({}),
      setModel: async () => {},
      setMcpServers: async () => ({ added: [], removed: [], errors: [] }),
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      toggleMcpServer: async () => {},
    }) as unknown as Query
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query

  return { impl, push, end }
}
