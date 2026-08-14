/**
 * Behavioral contract every ModelProvider implementation must satisfy.
 * Run this suite against fakes and, later, real adapters (Anthropic, OpenAI,
 * ...) so orchestration code can trust a single set of guarantees regardless
 * of which provider is behind it.
 */

import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from '@overture/core'
import { describe, expect, it } from 'vitest'

const STOP_REASONS = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal']

export interface ModelProviderContractOptions {
  /** A ModelRequest the provider under test can answer. */
  readonly request?: ModelRequest
}

const defaultRequest: ModelRequest = {
  model: 'contract-test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

function expectValidResponse(response: ModelResponse): void {
  expect(typeof response.model).toBe('string')
  expect(Array.isArray(response.content)).toBe(true)
  expect(response.content.length).toBeGreaterThan(0)
  expect(STOP_REASONS).toContain(response.stopReason)
  expect(typeof response.usage.inputTokens).toBe('number')
  expect(typeof response.usage.outputTokens).toBe('number')
}

/**
 * @param factory Returns a fresh, ready-to-answer provider for each test.
 *   For scripted fakes this means a new instance with its own script.
 */
export function describeModelProviderContract(
  name: string,
  factory: () => ModelProvider | Promise<ModelProvider>,
  options: ModelProviderContractOptions = {},
): void {
  const request = options.request ?? defaultRequest

  describe(`ModelProvider contract: ${name}`, () => {
    it('exposes static provider info identifying it as a model provider', async () => {
      const provider = await factory()
      expect(provider.info.id).toBeTruthy()
      expect(provider.info.kind).toBe('model')
    })

    it('detect() reports availability', async () => {
      const provider = await factory()
      const availability = await provider.detect()
      expect(typeof availability.available).toBe('boolean')
      expect(typeof availability.installed).toBe('boolean')
      expect(typeof availability.authenticated).toBe('boolean')
    })

    it('complete() returns a well-formed terminal response', async () => {
      const provider = await factory()
      const response = await provider.complete(request)
      expectValidResponse(response)
    })

    it("stream() terminates with a single 'response' event shaped like complete()'s result", async () => {
      const provider = await factory()
      const events: ModelStreamEvent[] = []
      for await (const event of provider.stream(request)) events.push(event)

      expect(events.length).toBeGreaterThan(0)
      const responseEvents = events.filter((e) => e.type === 'response')
      expect(responseEvents).toHaveLength(1)

      const last = events[events.length - 1]
      expect(last?.type).toBe('response')
      if (last?.type === 'response') expectValidResponse(last.response)
    })

    it('honors an already-aborted signal on complete()', async () => {
      const provider = await factory()
      const controller = new AbortController()
      controller.abort()
      await expect(provider.complete(request, controller.signal)).rejects.toThrow()
    })

    it('honors an already-aborted signal on stream()', async () => {
      const provider = await factory()
      const controller = new AbortController()
      controller.abort()
      const drain = async () => {
        for await (const _event of provider.stream(request, controller.signal)) {
          // draining is enough to trigger the throw
        }
      }
      await expect(drain()).rejects.toThrow()
    })
  })
}
