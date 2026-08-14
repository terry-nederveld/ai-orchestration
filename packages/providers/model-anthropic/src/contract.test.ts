import { describeModelProviderContract } from '@overture/testkit'
import { AnthropicModelProvider } from './provider.js'
import { jsonResponse, routedFetch, sseEvent, sseResponse } from './test-helpers.js'

/**
 * Wires the shared ModelProvider contract suite against a fake-fetch-backed
 * AnthropicModelProvider so it's held to the same behavioral guarantees as
 * every other provider (fakes included). Routes by request shape rather
 * than a fixed queue, since the contract suite calls complete()/stream()/
 * detect() independently across separate tests in no fixed order.
 */
describeModelProviderContract('AnthropicModelProvider', () => {
  const completeResponse = () =>
    jsonResponse(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'contract-test-model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

  const streamResponse = () => {
    const sse =
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'm1',
          model: 'contract-test-model',
          role: 'assistant',
          usage: { input_tokens: 1 },
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
        delta: { type: 'text_delta', text: 'ok' },
      }) +
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }) +
      sseEvent('message_stop', { type: 'message_stop' })
    return sseResponse([sse])
  }

  const fetchImpl = routedFetch((url, init) => {
    if (url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'contract-test-model' }] })
    const body = JSON.parse(String(init.body ?? '{}')) as { stream?: boolean }
    return body.stream ? streamResponse() : completeResponse()
  })

  return new AnthropicModelProvider({ apiKey: async () => 'sk-ant-test', fetchImpl })
})
