import { describeModelProviderContract } from '@overture/testkit'
import { OpenAIModelProvider } from './provider.js'
import { jsonResponse, routedFetch, sseChunk, sseDone, sseResponse } from './test-helpers.js'

/**
 * Wires the shared ModelProvider contract suite against a fake-fetch-backed
 * OpenAIModelProvider so it's held to the same behavioral guarantees as
 * every other provider (fakes included). Routes by request shape rather
 * than a fixed queue, since the contract suite calls complete()/stream()/
 * detect() independently across separate tests in no fixed order.
 */
describeModelProviderContract('OpenAIModelProvider', () => {
  const completeResponse = () =>
    jsonResponse(200, {
      id: 'chatcmpl_1',
      model: 'contract-test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })

  const streamResponse = () => {
    const sse =
      sseChunk({
        model: 'contract-test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
      }) +
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      sseChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
      sseDone()
    return sseResponse([sse])
  }

  const fetchImpl = routedFetch((url, init) => {
    if (url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'contract-test-model' }] })
    const body = JSON.parse(String(init.body ?? '{}')) as { stream?: boolean }
    return body.stream ? streamResponse() : completeResponse()
  })

  return new OpenAIModelProvider({ apiKey: async () => 'sk-test', fetchImpl })
})
