import type { Message, ModelRequest } from '@overture/core'
import { describe, expect, it } from 'vitest'
import {
  fromOpenAiFinishReason,
  fromOpenAiResponse,
  fromOpenAiUsage,
  parseToolCallArguments,
  toOpenAiRequest,
} from './mapping.js'
import type { OpenAiChatCompletionResponse } from './openai-types.js'

describe('toOpenAiRequest', () => {
  it('round-trips a conversation with tool calls and tool results into the exact OpenAI JSON body', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me calculate.' },
          { type: 'tool_call', id: 'call_1', name: 'calculator', input: { expression: '2+2' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call_1', content: '4' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }] },
    ]
    const request: ModelRequest = {
      model: 'gpt-4.1',
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

    expect(toOpenAiRequest(request, false)).toEqual({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        {
          role: 'assistant',
          content: 'Let me calculate.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'calculator', arguments: '{"expression":"2+2"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '4' },
        { role: 'assistant', content: 'The answer is 4.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Evaluates a math expression',
            parameters: { type: 'object', properties: { expression: { type: 'string' } } },
          },
        },
      ],
      max_tokens: 1024,
      temperature: 0.5,
      stop: ['STOP'],
    })
  })

  it('emits one tool message per tool_result block when a tool message carries several', () => {
    const request: ModelRequest = {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'c1', content: 'r1' },
            { type: 'tool_result', toolCallId: 'c2', content: 'r2' },
          ],
        },
      ],
    }
    const body = toOpenAiRequest(request, false)
    expect(body.messages).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ])
  })

  it('sets assistant content to null when the assistant message has only tool calls', () => {
    const request: ModelRequest = {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'search', input: {} }],
        },
      ],
    }
    const body = toOpenAiRequest(request, false)
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    })
  })

  it('maps image blocks to data-URI image_url parts', () => {
    const request: ModelRequest = {
      model: 'gpt-4.1',
      messages: [
        { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'QUJD' }] },
      ],
    }
    const body = toOpenAiRequest(request, false)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
    })
  })

  it('maps reasoningEffort low/medium/high straight through, and omits it for none/unset', () => {
    expect(
      toOpenAiRequest({ model: 'm', messages: [], reasoningEffort: 'low' }, false).reasoning_effort,
    ).toBe('low')
    expect(
      toOpenAiRequest({ model: 'm', messages: [], reasoningEffort: 'medium' }, false)
        .reasoning_effort,
    ).toBe('medium')
    expect(
      toOpenAiRequest({ model: 'm', messages: [], reasoningEffort: 'high' }, false)
        .reasoning_effort,
    ).toBe('high')
    expect(
      toOpenAiRequest({ model: 'm', messages: [], reasoningEffort: 'none' }, false)
        .reasoning_effort,
    ).toBeUndefined()
    expect(toOpenAiRequest({ model: 'm', messages: [] }, false).reasoning_effort).toBeUndefined()
  })

  it('sets stream: true and stream_options.include_usage only when streaming', () => {
    const request: ModelRequest = { model: 'm', messages: [] }
    expect(toOpenAiRequest(request, true)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(toOpenAiRequest(request, false).stream).toBeUndefined()
    expect(toOpenAiRequest(request, false).stream_options).toBeUndefined()
  })

  it('omits max_tokens when unspecified', () => {
    expect(toOpenAiRequest({ model: 'm', messages: [] }, false).max_tokens).toBeUndefined()
  })
})

describe('fromOpenAiFinishReason', () => {
  it.each([
    ['stop', 'end_turn'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    [null, 'end_turn'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(fromOpenAiFinishReason(input)).toBe(expected)
  })
})

describe('fromOpenAiUsage', () => {
  it('maps prompt/completion tokens', () => {
    expect(fromOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })
  })

  it('maps cached tokens to cacheReadTokens when present', () => {
    expect(
      fromOpenAiUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 })
  })
})

describe('fromOpenAiResponse', () => {
  it('maps text content and tool_calls, parsing arguments JSON', () => {
    const response: OpenAiChatCompletionResponse = {
      id: 'chatcmpl_1',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    }
    expect(fromOpenAiResponse(response)).toEqual({
      model: 'gpt-4.1',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 34 },
    })
  })

  it('throws corrupt-response for invalid tool_call arguments JSON', () => {
    const response: OpenAiChatCompletionResponse = {
      id: 'chatcmpl_1',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'search', arguments: '{bad' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    expect(() => fromOpenAiResponse(response)).toThrowError(
      expect.objectContaining({ category: 'corrupt-response' }),
    )
  })

  it('falls back to zero usage when the response has none', () => {
    const response: OpenAiChatCompletionResponse = {
      id: 'chatcmpl_1',
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }
    expect(fromOpenAiResponse(response).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('parseToolCallArguments', () => {
  it('parses valid JSON', () => {
    expect(parseToolCallArguments('{"a":1}', 'tool')).toEqual({ a: 1 })
  })

  it('returns {} for empty input', () => {
    expect(parseToolCallArguments('', 'tool')).toEqual({})
  })

  it('throws a corrupt-response OrchestratorError for invalid JSON', () => {
    expect(() => parseToolCallArguments('{not json', 'tool')).toThrowError(
      expect.objectContaining({ category: 'corrupt-response' }),
    )
  })
})
