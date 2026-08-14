import type { ModelRequest } from '@overture/core'
import { collectResponse } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { AnthropicModelProvider } from './provider.js'
import {
  fakeFetch,
  jsonResponse,
  sseEvent,
  sseResponse,
  textErrorResponse,
} from './test-helpers.js'

const request: ModelRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

function makeProvider(fetchImpl: typeof fetch, apiKey: string | undefined = 'sk-ant-test') {
  return new AnthropicModelProvider({ apiKey: async () => apiKey, fetchImpl })
}

describe('AnthropicModelProvider.complete', () => {
  it('sends the anthropic-version header and API key, and maps a successful response', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello there' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.complete(request)

    expect(response).toEqual({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hello there' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
  })

  it('maps 429 responses to a retryable rate-limit error carrying retryAfterMs', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', {
        'retry-after': '2',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.complete(request)).rejects.toMatchObject({
      category: 'rate-limit',
      retryable: true,
      options: { retryAfterMs: 2000 },
    })
  })

  it.each([401, 403])('maps %d responses to a non-retryable auth-expired error', async (status) => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(status, '{"error":{"type":"authentication_error","message":"bad key"}}'),
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

describe('AnthropicModelProvider.stream', () => {
  it('parses SSE events into deltas and a terminal response, split across multiple chunk boundaries', async () => {
    const fullSse =
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          usage: { input_tokens: 10 },
        },
      }) +
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }) +
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      }) +
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} },
      }) +
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      }) +
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      }) +
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      }) +
      sseEvent('message_stop', { type: 'message_stop' })

    // Split at three arbitrary byte offsets to prove buffering across boundaries mid-line.
    const cut1 = fullSse.indexOf('"text_delta","text":"Hel') + 5
    const cut2 = fullSse.indexOf('input_json_delta') + 8
    const cut3 = fullSse.indexOf('message_stop', cut2)
    const chunks = [
      fullSse.slice(0, cut1),
      fullSse.slice(cut1, cut2),
      fullSse.slice(cut2, cut3),
      fullSse.slice(cut3),
    ]

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
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 7 },
    })
  })

  it('throws when the server sends a stream error event', async () => {
    const sse = sseEvent('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'overloaded' },
    })
    const { fetchImpl } = fakeFetch([sseResponse([sse])])
    const provider = makeProvider(fetchImpl)

    const drain = async () => {
      for await (const _event of provider.stream(request)) {
        // draining is enough to trigger the throw
      }
    }
    await expect(drain()).rejects.toThrow(/overloaded/)
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

describe('AnthropicModelProvider.detect / listModels', () => {
  it('reports unauthenticated when no API key resolves', async () => {
    const { fetchImpl } = fakeFetch([])
    const provider = makeProvider(fetchImpl, undefined)
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: false, authenticated: false, installed: true })
  })

  it('reports available and lists model ids when the key resolves and /models succeeds', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }),
    ])
    const provider = makeProvider(fetchImpl)
    const availability = await provider.detect()
    expect(availability).toMatchObject({
      available: true,
      authenticated: true,
      models: ['claude-sonnet-4-5'],
    })
  })

  it('listModels maps id and displayName', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }),
    ])
    const provider = makeProvider(fetchImpl)
    const models = await provider.listModels()
    expect(models).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }])
  })
})

describe('AnthropicModelProvider.capabilities', () => {
  it('advertises the expected capability set', () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch)
    const caps = provider.capabilities()
    for (const cap of [
      'chat',
      'tool_use',
      'parallel_tool_use',
      'vision',
      'streaming',
      'long_context',
      'reasoning',
      'structured_output',
    ] as const) {
      expect(caps.has(cap)).toBe(true)
    }
  })
})
