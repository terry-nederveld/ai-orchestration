import {
  Capability,
  CapabilitySet,
  collectResponse,
  type ModelRequest,
  type ModelStreamEvent,
} from '@overture/core'
import { describe, expect, it } from 'vitest'
import { describeModelProviderContract } from './contracts/model-provider.contract.js'
import { ScriptedModelProvider } from './model-provider.js'

const request: ModelRequest = {
  model: 'contract-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

describeModelProviderContract(
  'ScriptedModelProvider',
  () => new ScriptedModelProvider([{ kind: 'text', text: 'hello' }]),
)

describe('ScriptedModelProvider', () => {
  it('records every received request', async () => {
    const provider = new ScriptedModelProvider([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ])
    await provider.complete(request)
    await provider.complete({ ...request, model: 'other-model' })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.model).toBe('other-model')
  })

  it('produces a tool_call response with stopReason tool_use', async () => {
    const provider = new ScriptedModelProvider([
      { kind: 'tool_call', name: 'read_file', input: { path: '/tmp/x' }, id: 'call-1' },
    ])
    const response = await provider.complete(request)
    expect(response.stopReason).toBe('tool_use')
    expect(response.content).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: '/tmp/x' } },
    ])
  })

  it('supports multiple tool calls in a single turn', async () => {
    const provider = new ScriptedModelProvider([
      {
        kind: 'tool_call',
        name: 'read_file',
        input: { path: 'a.txt' },
        additionalCalls: [
          { name: 'read_file', input: { path: 'b.txt' } },
          { name: 'read_file', input: { path: 'c.txt' } },
        ],
      },
    ])
    const response = await provider.complete(request)
    expect(response.content).toHaveLength(3)
    expect(response.content.map((b) => (b.type === 'tool_call' ? b.name : undefined))).toEqual([
      'read_file',
      'read_file',
      'read_file',
    ])
  })

  it('produces a max_tokens response simulating context exhaustion', async () => {
    const provider = new ScriptedModelProvider([{ kind: 'max_tokens', text: 'truncated...' }])
    const response = await provider.complete(request)
    expect(response.stopReason).toBe('max_tokens')
    expect(response.content).toEqual([{ type: 'text', text: 'truncated...' }])
  })

  it('throws an OrchestratorError for a fail turn, carrying its category', async () => {
    const provider = new ScriptedModelProvider([
      { kind: 'fail', error: 'rate limited', category: 'rate-limit' },
    ])
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'OrchestratorError',
      category: 'rate-limit',
      message: 'rate limited',
    })
  })

  it('throws a timeout OrchestratorError after waiting for a timeout turn', async () => {
    const provider = new ScriptedModelProvider([{ kind: 'timeout', afterMs: 5 }])
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'OrchestratorError',
      category: 'timeout',
    })
  })

  it('rejects a timeout turn early when the signal aborts mid-wait', async () => {
    const provider = new ScriptedModelProvider([{ kind: 'timeout', afterMs: 10_000 }])
    const controller = new AbortController()
    const promise = provider.complete(request, controller.signal)
    queueMicrotask(() => controller.abort())
    await expect(promise).rejects.toThrow()
  })

  it('throws a clear error when the script is exhausted', async () => {
    const provider = new ScriptedModelProvider([])
    await expect(provider.complete(request)).rejects.toThrow(/script exhausted/)
  })

  it('applies configured default usage and per-turn overrides', async () => {
    const provider = new ScriptedModelProvider(
      [
        { kind: 'text', text: 'default usage' },
        { kind: 'text', text: 'custom usage', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      { defaultUsage: { inputTokens: 100, outputTokens: 50 } },
    )
    const first = await provider.complete(request)
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    const second = await provider.complete(request)
    expect(second.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  it('streams realistic incremental text_delta events before the terminal response', async () => {
    const provider = new ScriptedModelProvider([{ kind: 'text', text: 'hello world' }], {
      streamChunkSize: 4,
    })
    const events: ModelStreamEvent[] = []
    for await (const event of provider.stream(request)) events.push(event)

    const deltas = events.filter((e) => e.type === 'text_delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe('hello world')
    expect(events[events.length - 1]?.type).toBe('response')
  })

  it('streams tool_call_started/tool_call_delta events for tool_call turns', async () => {
    const provider = new ScriptedModelProvider([
      { kind: 'tool_call', name: 'search', input: { query: 'overture' }, id: 'call-1' },
    ])
    const events: ModelStreamEvent[] = []
    for await (const event of provider.stream(request)) events.push(event)

    expect(events[0]).toEqual({ type: 'tool_call_started', id: 'call-1', name: 'search' })
    const deltas = events.filter((e) => e.type === 'tool_call_delta')
    expect(deltas.length).toBeGreaterThan(0)
    const response = await collectResponse(
      (async function* () {
        for (const e of events) yield e
      })(),
    )
    expect(response.content).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'search', input: { query: 'overture' } },
    ])
  })

  it('reports configured capabilities, models, and availability', async () => {
    const provider = new ScriptedModelProvider([], {
      capabilities: CapabilitySet.of(Capability.Vision),
      models: [{ id: 'model-a' }, { id: 'model-b' }],
      availability: { authenticated: false, available: false },
    })
    expect(provider.capabilities().has(Capability.Vision)).toBe(true)
    expect(provider.capabilities().has(Capability.ToolUse)).toBe(false)
    expect(await provider.listModels()).toEqual([{ id: 'model-a' }, { id: 'model-b' }])
    const availability = await provider.detect()
    expect(availability.authenticated).toBe(false)
    expect(availability.available).toBe(false)
  })
})
