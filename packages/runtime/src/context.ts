/**
 * Context management: compaction of long conversations into a summary plus a
 * recent-message tail, so long-running sessions stay inside context windows.
 */

import type { Message, ModelProvider } from '@overture/core'

export interface CompactionOptions {
  /** Input-token level (from the latest response) that triggers compaction. */
  readonly triggerInputTokens: number
  /** Messages preserved verbatim at the end of the conversation. */
  readonly keepRecentMessages: number
  readonly summaryModel?: string
}

export const defaultCompactionOptions: CompactionOptions = {
  triggerInputTokens: 150_000,
  keepRecentMessages: 6,
}

export interface CompactionResult {
  readonly messages: readonly Message[]
  readonly compacted: boolean
}

/**
 * Replace all but the most recent messages with a model-produced summary.
 * On summary failure the original conversation is returned unchanged; the
 * caller may retry on the next turn.
 */
export async function compactMessages(
  provider: ModelProvider,
  model: string,
  messages: readonly Message[],
  options: CompactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const keep = Math.max(options.keepRecentMessages, 2)
  if (messages.length <= keep + 2) return { messages, compacted: false }

  const head = messages.slice(0, messages.length - keep)
  const tail = messages.slice(messages.length - keep)

  try {
    const response = await provider.complete(
      {
        model: options.summaryModel ?? model,
        system:
          'Summarize the following agent conversation for continuation. Preserve: the goal, ' +
          'decisions made, files and identifiers touched, tool outcomes that matter, open ' +
          'problems, and next steps. Be dense and factual.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: transcriptOf(head) }],
          },
        ],
        maxOutputTokens: 4_000,
      },
      signal,
    )
    const summary = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (!summary.trim()) return { messages, compacted: false }
    const summaryMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Conversation summary — earlier turns compacted]\n${summary}`,
        },
      ],
    }
    return { messages: [summaryMessage, ...sanitizeTail(tail)], compacted: true }
  } catch {
    return { messages, compacted: false }
  }
}

/**
 * A compacted tail must not begin with tool results whose tool calls were
 * summarized away; convert orphaned tool results into plain text.
 */
function sanitizeTail(tail: readonly Message[]): readonly Message[] {
  const knownCallIds = new Set<string>()
  return tail.map((message) => {
    for (const block of message.content) {
      if (block.type === 'tool_call') knownCallIds.add(block.id)
    }
    const hasOrphan = message.content.some(
      (block) => block.type === 'tool_result' && !knownCallIds.has(block.toolCallId),
    )
    if (!hasOrphan) return message
    return {
      role: message.role,
      content: message.content.map((block) =>
        block.type === 'tool_result' && !knownCallIds.has(block.toolCallId)
          ? { type: 'text', text: `[Earlier tool result]\n${block.content}` }
          : block,
      ),
    }
  })
}

function transcriptOf(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const parts = message.content
        .map((block) => {
          if (block.type === 'text') return block.text
          if (block.type === 'tool_call') {
            return `[tool call ${block.name}: ${JSON.stringify(block.input)}]`
          }
          if (block.type === 'tool_result') {
            return `[tool result: ${truncate(block.content, 2_000)}]`
          }
          if (block.type === 'image') return '[image]'
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return `${message.role}: ${parts}`
    })
    .join('\n\n')
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`
}
