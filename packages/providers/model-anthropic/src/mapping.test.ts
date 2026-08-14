import type { Message, ModelRequest } from '@overture/core'
import { describe, expect, it } from 'vitest'
import type { AnthropicMessageResponse } from './anthropic-types.js'
import {
  fromAnthropicResponse,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  parseToolInputJson,
  toAnthropicRequest,
} from './mapping.js'

describe('toAnthropicRequest', () => {
  it('round-trips a conversation with tool calls and tool results into the exact Anthropic JSON body', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me calculate.' },
          { type: 'tool_call', id: 'call_1', name: 'calculator', input: { expression: '2+2' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: '4' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }] },
    ]
    const request: ModelRequest = {
      model: 'claude-sonnet-4-5',
      system: 'You are a helpful assistant.',
      messages,
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates a math expression',
          inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
        },
      ],
      maxOutputTokens: 1024,
      temperature: 0.5,
      stopSequences: ['STOP'],
    }

    expect(toAnthropicRequest(request, false)).toEqual({
      model: 'claude-sonnet-4-5',
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me calculate.' },
            { type: 'tool_use', id: 'call_1', name: 'calculator', input: { expression: '2+2' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '4' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }] },
      ],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates a math expression',
          input_schema: { type: 'object', properties: { expression: { type: 'string' } } },
        },
      ],
      max_tokens: 1024,
      temperature: 0.5,
      stop_sequences: ['STOP'],
    })
  })

  it('marks tool_result as an error when isError is set', () => {
    const request: ModelRequest = {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'c1', content: 'boom', isError: true }],
        },
      ],
    }
    const body = toAnthropicRequest(request, false)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }],
    })
  })

  it('maps image blocks to base64 source objects', () => {
    const request: ModelRequest = {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'QUJD' }] },
      ],
    }
    const body = toAnthropicRequest(request, false)
    expect(body.messages[0]?.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    })
  })

  it('drops thinking blocks without raw and passes through thinking blocks that carry raw', () => {
    const request: ModelRequest = {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'no raw, drop me' },
            {
              type: 'thinking',
              text: 'has raw',
              raw: { type: 'thinking', thinking: 'has raw', signature: 'sig' },
            },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    }
    const body = toAnthropicRequest(request, false)
    expect(body.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'has raw', signature: 'sig' },
      { type: 'text', text: 'done' },
    ])
  })

  it('defaults max_tokens to 4096 when unspecified', () => {
    const request: ModelRequest = { model: 'm', messages: [] }
    expect(toAnthropicRequest(request, false).max_tokens).toBe(4096)
  })

  it.each([
    ['low', 2048],
    ['medium', 8192],
    ['high', 16384],
  ] as const)(
    'maps reasoningEffort %s to a thinking budget of %d tokens with adequate max_tokens',
    (effort, budget) => {
      const request: ModelRequest = { model: 'm', messages: [], reasoningEffort: effort }
      const body = toAnthropicRequest(request, false)
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget })
      expect(body.max_tokens).toBeGreaterThan(budget)
    },
  )

  it('omits thinking config when reasoningEffort is "none" or unset', () => {
    expect(
      toAnthropicRequest({ model: 'm', messages: [], reasoningEffort: 'none' }, false).thinking,
    ).toBeUndefined()
    expect(toAnthropicRequest({ model: 'm', messages: [] }, false).thinking).toBeUndefined()
  })

  it('respects an explicit maxOutputTokens larger than the thinking budget', () => {
    const request: ModelRequest = {
      model: 'm',
      messages: [],
      reasoningEffort: 'low',
      maxOutputTokens: 20000,
    }
    expect(toAnthropicRequest(request, false).max_tokens).toBe(20000)
  })

  it('sets stream: true only when requested', () => {
    const request: ModelRequest = { model: 'm', messages: [] }
    expect(toAnthropicRequest(request, true).stream).toBe(true)
    expect(toAnthropicRequest(request, false).stream).toBeUndefined()
  })
})

describe('fromAnthropicStopReason', () => {
  it.each([
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'stop_sequence'],
    ['refusal', 'refusal'],
    [null, 'end_turn'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(fromAnthropicStopReason(input)).toBe(expected)
  })
})

describe('fromAnthropicUsage', () => {
  it('maps token counts including cache fields', () => {
    expect(
      fromAnthropicUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 })
  })

  it('omits cache fields entirely when absent, rather than setting them to undefined', () => {
    const usage = fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect('cacheReadTokens' in usage).toBe(false)
    expect('cacheWriteTokens' in usage).toBe(false)
  })
})

describe('fromAnthropicResponse', () => {
  it('maps text, tool_use, and thinking content blocks', () => {
    const response: AnthropicMessageResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
        { type: 'thinking', thinking: 'pondering', signature: 'sig' },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34 },
    }
    const result = fromAnthropicResponse(response)
    expect(result).toEqual({
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'x' } },
        {
          type: 'thinking',
          text: 'pondering',
          raw: { type: 'thinking', thinking: 'pondering', signature: 'sig' },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 34 },
    })
  })
})

describe('parseToolInputJson', () => {
  it('parses valid JSON', () => {
    expect(parseToolInputJson('{"a":1}', 'tool')).toEqual({ a: 1 })
  })

  it('returns {} for empty input', () => {
    expect(parseToolInputJson('', 'tool')).toEqual({})
  })

  it('throws a corrupt-response OrchestratorError for invalid JSON', () => {
    expect(() => parseToolInputJson('{not json', 'tool')).toThrowError(
      expect.objectContaining({ category: 'corrupt-response' }),
    )
  })
})
