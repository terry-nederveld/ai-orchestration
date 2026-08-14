/**
 * Pure reduction of an ordered `OrchestratorEvent` stream into the model
 * `RunDetail` renders: a workflow step timeline, an agent transcript (text
 * accumulated across deltas, tool calls collapsed into single entries), and
 * aggregate usage. No React, no I/O — trivial to unit test exhaustively.
 */
import type { OrchestratorEvent } from '../../api/types'

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface StepTimelineEntry {
  readonly stepId: string
  readonly status: StepStatus
  readonly startedAt?: string
  readonly finishedAt?: string
}

export type ToolCallStatus = 'running' | 'succeeded' | 'failed'

export interface ToolCallEntry {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  readonly status: ToolCallStatus
  readonly result?: string
  readonly isError?: boolean
}

export type TranscriptEntry =
  | { readonly kind: 'text'; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'thinking'; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'tool'; readonly sessionId: string; readonly call: ToolCallEntry }
  | { readonly kind: 'waiting-human'; readonly sessionId: string; readonly reason: string }
  | {
      readonly kind: 'subagent'
      readonly sessionId: string
      readonly childSessionId: string
      readonly status: 'running' | 'completed'
      readonly outcome?: string
    }

export interface RunTimelineUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly turns: number
}

export interface RunTimelineModel {
  readonly steps: readonly StepTimelineEntry[]
  readonly transcript: readonly TranscriptEntry[]
  readonly usage: RunTimelineUsage
}

const EMPTY_USAGE: RunTimelineUsage = { inputTokens: 0, outputTokens: 0, turns: 0 }

export function reduceRunTimeline(events: readonly OrchestratorEvent[]): RunTimelineModel {
  const steps: StepTimelineEntry[] = []
  const stepIndex = new Map<string, number>()
  const transcript: TranscriptEntry[] = []
  let usage: RunTimelineUsage = EMPTY_USAGE

  const upsertStep = (stepId: string, patch: Partial<StepTimelineEntry>): void => {
    const index = stepIndex.get(stepId)
    if (index === undefined) {
      stepIndex.set(stepId, steps.length)
      steps.push({ stepId, status: 'pending', ...patch })
      return
    }
    const existing = steps[index]
    if (existing) steps[index] = { ...existing, ...patch }
  }

  for (const event of events) {
    switch (event.type) {
      case 'workflow.step.started': {
        upsertStep(event.stepId, { status: 'running', startedAt: event.at })
        break
      }
      case 'workflow.step.completed': {
        upsertStep(event.stepId, { status: event.status, finishedAt: event.at })
        break
      }
      case 'agent': {
        const { sessionId, event: agentEvent } = event
        switch (agentEvent.type) {
          case 'agent.text': {
            const last = transcript[transcript.length - 1]
            if (last && last.kind === 'text' && last.sessionId === sessionId) {
              transcript[transcript.length - 1] = { ...last, text: last.text + agentEvent.text }
            } else {
              transcript.push({ kind: 'text', sessionId, text: agentEvent.text })
            }
            break
          }
          case 'agent.thinking': {
            const last = transcript[transcript.length - 1]
            if (last && last.kind === 'thinking' && last.sessionId === sessionId) {
              transcript[transcript.length - 1] = { ...last, text: last.text + agentEvent.text }
            } else {
              transcript.push({ kind: 'thinking', sessionId, text: agentEvent.text })
            }
            break
          }
          case 'agent.tool.started': {
            transcript.push({
              kind: 'tool',
              sessionId,
              call: {
                toolCallId: agentEvent.toolCallId,
                toolName: agentEvent.toolName,
                input: agentEvent.input,
                status: 'running',
              },
            })
            break
          }
          case 'agent.tool.completed': {
            for (let i = transcript.length - 1; i >= 0; i -= 1) {
              const entry = transcript[i]
              if (entry?.kind === 'tool' && entry.call.toolCallId === agentEvent.toolCallId) {
                transcript[i] = {
                  ...entry,
                  call: {
                    ...entry.call,
                    status: agentEvent.isError ? 'failed' : 'succeeded',
                    result: agentEvent.content,
                    isError: agentEvent.isError,
                  },
                }
                break
              }
            }
            break
          }
          case 'agent.waiting.human': {
            transcript.push({ kind: 'waiting-human', sessionId, reason: agentEvent.reason })
            break
          }
          case 'agent.subagent.started': {
            transcript.push({
              kind: 'subagent',
              sessionId,
              childSessionId: agentEvent.childSessionId,
              status: 'running',
            })
            break
          }
          case 'agent.subagent.completed': {
            for (let i = transcript.length - 1; i >= 0; i -= 1) {
              const entry = transcript[i]
              if (
                entry?.kind === 'subagent' &&
                entry.childSessionId === agentEvent.childSessionId &&
                entry.status === 'running'
              ) {
                transcript[i] = { ...entry, status: 'completed', outcome: agentEvent.outcome }
                break
              }
            }
            break
          }
          case 'agent.turn.started': {
            usage = { ...usage, turns: usage.turns + 1 }
            break
          }
          case 'agent.usage': {
            usage = {
              ...usage,
              inputTokens: usage.inputTokens + agentEvent.usage.inputTokens,
              outputTokens: usage.outputTokens + agentEvent.usage.outputTokens,
            }
            break
          }
          default:
            break
        }
        break
      }
      default:
        break
    }
  }

  return { steps, transcript, usage }
}
