/**
 * Translation between the core neutral ModelRequest/ModelResponse shapes and
 * the OpenAI Chat Completions wire format (also served by OpenAI-compatible
 * endpoints: OpenRouter, Ollama, vLLM, ...).
 */

import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  StopReason,
  TokenUsage,
  ToolCallBlock,
} from '@overture/core'
import { OrchestratorError } from '@overture/core'
import type {
  OpenAiChatCompletionResponse,
  OpenAiContentPart,
  OpenAiFinishReason,
  OpenAiMessage,
  OpenAiRequestBody,
  OpenAiToolCall,
  OpenAiUsage,
} from './openai-types.js'

function toOpenAiContentParts(content: readonly ContentBlock[]): OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      })
    }
    // tool_call/tool_result/thinking blocks are not valid in a user message; ignore if misplaced
  }
  return parts
}

function assistantMessageFrom(message: Message): OpenAiMessage {
  const textParts = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
  )
  const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call')
  const content = textParts.length > 0 ? textParts.map((b) => b.text).join('') : null
  const tool_calls: OpenAiToolCall[] = toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
  }))
  return {
    role: 'assistant',
    content,
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
  }
}

function toolResultMessagesFrom(message: Message): OpenAiMessage[] {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((block) => ({
      role: 'tool' as const,
      tool_call_id: block.toolCallId,
      content: block.content,
    }))
}

export function toOpenAiMessages(messages: readonly Message[]): OpenAiMessage[] {
  const result: OpenAiMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text = message.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n')
        if (text) result.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = toOpenAiContentParts(message.content)
        if (parts.length > 0) result.push({ role: 'user', content: parts })
        break
      }
      case 'assistant': {
        result.push(assistantMessageFrom(message))
        break
      }
      case 'tool': {
        result.push(...toolResultMessagesFrom(message))
        break
      }
      default:
        break
    }
  }
  return result
}

export function toOpenAiRequest(request: ModelRequest, stream: boolean): OpenAiRequestBody {
  const messages: OpenAiMessage[] = []
  if (request.system) messages.push({ role: 'system', content: request.system })
  messages.push(...toOpenAiMessages(request.messages))

  const reasoningEffort =
    request.reasoningEffort && request.reasoningEffort !== 'none'
      ? request.reasoningEffort
      : undefined

  return {
    model: request.model,
    messages,
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stopSequences && request.stopSequences.length > 0
      ? { stop: request.stopSequences }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  }
}

export function fromOpenAiFinishReason(reason: OpenAiFinishReason): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export function fromOpenAiUsage(usage: OpenAiUsage): TokenUsage {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  }
}

export function parseToolCallArguments(raw: string, toolName: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new OrchestratorError(
      `corrupt tool_call arguments JSON for tool "${toolName}": ${String(error)}`,
      'corrupt-response',
      { retryable: false, cause: error },
    )
  }
}

function fromOpenAiToolCalls(toolCalls: readonly OpenAiToolCall[]): ToolCallBlock[] {
  return toolCalls.map((call) => ({
    type: 'tool_call',
    id: call.id,
    name: call.function.name,
    input: parseToolCallArguments(call.function.arguments, call.function.name),
  }))
}

export function fromOpenAiResponse(response: OpenAiChatCompletionResponse): ModelResponse {
  const choice = response.choices[0]
  if (!choice)
    throw new OrchestratorError('OpenAI response contained no choices', 'corrupt-response', {
      retryable: false,
    })

  const content: ContentBlock[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    content.push(...fromOpenAiToolCalls(choice.message.tool_calls))
  }

  return {
    model: response.model,
    content,
    stopReason: fromOpenAiFinishReason(choice.finish_reason),
    usage: response.usage ? fromOpenAiUsage(response.usage) : { inputTokens: 0, outputTokens: 0 },
  }
}
