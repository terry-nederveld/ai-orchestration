import type { ModelRequest } from '@overture/core'
import { collectResponse } from '@overture/core'
import { describe, expect, it } from 'vitest'
import {
  createOllamaProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
} from './factories.js'
import { OpenAIModelProvider } from './provider.js'
import {
  fakeFetch,
  jsonResponse,
  sseChunk,
  sseDone,
  sseResponse,
  textErrorResponse,
} from './test-helpers.js'

const request: ModelRequest = {
  model: 'gpt-4.1',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

function makeProvider(fetchImpl: typeof fetch, apiKey: string | undefined = 'sk-test') {
  return new OpenAIModelProvider({ apiKey: async () => apiKey, fetchImpl })
}

describe('OpenAIModelProvider.complete', () => {
  it('sends a Bearer auth header and maps a successful response', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hello there' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.complete(request)

    expect(response).toEqual({
      model: 'gpt-4.1',
      content: [{ type: 'text', text: 'hello there' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('maps 429 responses to a retryable rate-limit error carrying retryAfterMs', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', {
        'retry-after': '3',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toMatchObject({
      category: 'rate-limit',
      retryable: true,
      options: { retryAfterMs: 3000 },
    })
  })

  it.each([401, 403])('maps %d responses to a non-retryable auth-expired error', async (status) => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(status, '{"error":{"type":"invalid_api_key","message":"bad key"}}'),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toMatchObject({
      category: 'auth-expired',
      retryable: false,
    })
  })

  it.each([500, 502, 503])(
    'maps %d responses to a retryable provider-outage error',
    async (status) => {
      const { fetchImpl } = fakeFetch([textErrorResponse(status, 'internal error')])
      const provider = makeProvider(fetchImpl)
      await expect(provider.complete(request)).rejects.toMatchObject({
        category: 'provider-outage',
        retryable: true,
      })
    },
  )

  it('maps other 4xx responses to a non-retryable invalid-input error', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(400, '{"error":{"type":"invalid_request_error","message":"bad request"}}'),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toMatchObject({
      category: 'invalid-input',
      retryable: false,
    })
  })

  it('maps a fetch-level network failure to a retryable network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toMatchObject({
      category: 'network',
      retryable: true,
    })
  })

  it('rejects immediately on an already-aborted signal without calling fetch', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const provider = makeProvider(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.complete(request, controller.signal)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('rethrows abort errors as-is rather than wrapping them', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('Aborted', 'AbortError')
    }) as typeof fetch
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    )
  })
})

describe('OpenAIModelProvider.stream', () => {
  it('accumulates text and tool_call deltas by index into a terminal response, split across chunk boundaries', async () => {
    const fullSse =
      sseChunk({
        model: 'gpt-4.1',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }],
      }) +
      sseChunk({ choices: [{ index: 0, delta: { content: 'lo' } }] }) +
      sseChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '' },
                },
              ],
            },
          },
        ],
      }) +
      sseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } },
        ],
      }) +
      sseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } },
        ],
      }) +
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      sseChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } }) +
      sseDone()

    // Split at proportional offsets rather than searching for field substrings: the
    // tool-call arguments fragment gets JSON-escaped by sseChunk (`{"q":` becomes
    // `{\"q\":`), so an unescaped needle wouldn't reliably land inside the payload.
    const cut1 = Math.floor(fullSse.length / 3)
    const cut2 = Math.floor((2 * fullSse.length) / 3)
    const chunks = [fullSse.slice(0, cut1), fullSse.slice(cut1, cut2), fullSse.slice(cut2)]

    const { fetchImpl } = fakeFetch([sseResponse(chunks)])
    const provider = makeProvider(fetchImpl)

    const events = []
    for await (const event of provider.stream(request)) events.push(event)

    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ])
    expect(events.filter((e) => e.type === 'tool_call_started')).toEqual([
      { type: 'tool_call_started', id: 'call_1', name: 'search' },
    ])
    expect(events.filter((e) => e.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', id: 'call_1', inputJsonDelta: '{"q":' },
      { type: 'tool_call_delta', id: 'call_1', inputJsonDelta: '"x"}' },
    ])

    const response = await collectResponse(
      (async function* () {
        yield* events
      })(),
    )
    expect(response).toEqual({
      model: 'gpt-4.1',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 7 },
    })
  })

  it('falls back to zero usage when the compatible server never sends a usage chunk', async () => {
    const sse =
      sseChunk({ model: 'llama3', choices: [{ index: 0, delta: { content: 'hi' } }] }) +
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      sseDone()
    const { fetchImpl } = fakeFetch([sseResponse([sse])])
    const provider = makeProvider(fetchImpl)
    const response = await collectResponse(provider.stream(request))
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('rejects immediately on an already-aborted signal without calling fetch', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const provider = makeProvider(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    const drain = async () => {
      for await (const _event of provider.stream(request, controller.signal)) {
        // draining is enough to trigger the throw
      }
    }
    await expect(drain()).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('OpenAIModelProvider.detect / listModels', () => {
  it('reports unauthenticated when no API key resolves and auth is required', async () => {
    const { fetchImpl } = fakeFetch([])
    const provider = makeProvider(fetchImpl, undefined)
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: false, authenticated: false, installed: true })
  })

  it('reports available and lists model ids when the key resolves and /models succeeds', async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { data: [{ id: 'gpt-4.1' }] })])
    const provider = makeProvider(fetchImpl)
    const availability = await provider.detect()
    expect(availability).toMatchObject({
      available: true,
      authenticated: true,
      models: ['gpt-4.1'],
    })
  })

  it('for requiresAuth: false providers, detect only checks that models are reachable', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: [{ id: 'llama3' }] })])
    const provider = createOllamaProvider({ fetchImpl })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: true, authenticated: true })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBeNull()
  })
})

describe('factory helpers', () => {
  it('createOpenAIProvider defaults id/baseUrl', () => {
    const provider = createOpenAIProvider({ apiKey: async () => 'k' })
    expect(provider.info.id).toBe('openai')
  })

  it('createOpenRouterProvider defaults id/baseUrl to OpenRouter', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: [] })])
    const provider = createOpenRouterProvider({ apiKey: async () => 'k', fetchImpl })
    expect(provider.info.id).toBe('openrouter')
    await provider.listModels()
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models')
  })

  it('createOllamaProvider defaults to localhost, local consumption, and no auth requirement', () => {
    const provider = createOllamaProvider()
    expect(provider.info.id).toBe('ollama')
    expect(provider.info.consumption).toBe('local')
    expect(provider.info.authentication).toEqual(['none'])
  })

  it('createOpenAICompatibleProvider uses the given id and baseUrl', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: [] })])
    const provider = createOpenAICompatibleProvider({
      id: 'vllm-cluster',
      baseUrl: 'http://vllm.internal:8000/v1',
      apiKey: async () => undefined,
      fetchImpl,
    })
    expect(provider.info.id).toBe('vllm-cluster')
    await provider.listModels()
    expect(calls[0]?.url).toBe('http://vllm.internal:8000/v1/models')
  })
})

describe('OpenAIModelProvider.capabilities', () => {
  it('advertises the expected capability set', () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch)
    const caps = provider.capabilities()
    for (const cap of [
      'chat',
      'tool_use',
      'parallel_tool_use',
      'vision',
      'streaming',
      'structured_output',
    ] as const) {
      expect(caps.has(cap)).toBe(true)
    }
  })
})
