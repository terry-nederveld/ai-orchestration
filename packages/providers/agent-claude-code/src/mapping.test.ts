import { describe, expect, it } from 'vitest'
import {
  fromAssistantMessage,
  fromUserMessage,
  resultSummary,
  ToolNameTracker,
  toAgentOutcome,
  toUsageRecord,
} from './mapping.js'
import {
  assistantMessage,
  resultError,
  resultSuccess,
  textBlock,
  thinkingBlock,
  toolResultBlock,
  toolUseBlock,
  userMessage,
} from './test-helpers.js'

describe('fromAssistantMessage', () => {
  it('maps a text block to agent.text', () => {
    const events = fromAssistantMessage(
      assistantMessage([textBlock('hello')]),
      new ToolNameTracker(),
    )
    expect(events).toEqual([{ type: 'agent.text', text: 'hello' }])
  })

  it('maps a thinking block to agent.thinking', () => {
    const events = fromAssistantMessage(
      assistantMessage([thinkingBlock('pondering')]),
      new ToolNameTracker(),
    )
    expect(events).toEqual([{ type: 'agent.thinking', text: 'pondering' }])
  })

  it('maps a tool_use block to agent.tool.started and remembers its name', () => {
    const tools = new ToolNameTracker()
    const events = fromAssistantMessage(
      assistantMessage([toolUseBlock('tool-1', 'Read', { path: 'a.txt' })]),
      tools,
    )
    expect(events).toEqual([
      {
        type: 'agent.tool.started',
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { path: 'a.txt' },
      },
    ])
    expect(tools.resolve('tool-1')).toBe('Read')
  })

  it('maps multiple content blocks in order', () => {
    const events = fromAssistantMessage(
      assistantMessage([textBlock('checking'), toolUseBlock('tool-2', 'Bash', { command: 'ls' })]),
      new ToolNameTracker(),
    )
    expect(events.map((e) => e.type)).toEqual(['agent.text', 'agent.tool.started'])
  })
})

describe('fromUserMessage', () => {
  it('maps a tool_result block to agent.tool.completed using the remembered tool name', () => {
    const tools = new ToolNameTracker()
    tools.remember('tool-1', 'Read')
    const events = fromUserMessage(userMessage([toolResultBlock('tool-1', 'file contents')]), tools)
    expect(events).toEqual([
      {
        type: 'agent.tool.completed',
        toolCallId: 'tool-1',
        toolName: 'Read',
        isError: false,
        content: 'file contents',
      },
    ])
  })

  it('reports isError from is_error and falls back to "unknown" for an untracked tool name', () => {
    const events = fromUserMessage(
      userMessage([toolResultBlock('tool-9', 'boom', true)]),
      new ToolNameTracker(),
    )
    expect(events).toEqual([
      {
        type: 'agent.tool.completed',
        toolCallId: 'tool-9',
        toolName: 'unknown',
        isError: true,
        content: 'boom',
      },
    ])
  })

  it('stringifies array tool_result content by joining text parts', () => {
    const events = fromUserMessage(
      userMessage([
        toolResultBlock('tool-1', [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ]),
      ]),
      new ToolNameTracker(),
    )
    expect(events[0]).toMatchObject({ content: 'line one\nline two' })
  })

  it('ignores non tool_result content blocks', () => {
    const events = fromUserMessage(
      userMessage([{ type: 'text', text: 'not a tool result' }]),
      new ToolNameTracker(),
    )
    expect(events).toEqual([])
  })
})

describe('toAgentOutcome', () => {
  it('maps success to GOAL_COMPLETED', () => {
    expect(toAgentOutcome(resultSuccess())).toBe('GOAL_COMPLETED')
  })

  it('maps error_max_turns to BUDGET_EXHAUSTED', () => {
    expect(toAgentOutcome(resultError('error_max_turns'))).toBe('BUDGET_EXHAUSTED')
  })

  it('maps error_max_budget_usd to BUDGET_EXHAUSTED', () => {
    expect(toAgentOutcome(resultError('error_max_budget_usd'))).toBe('BUDGET_EXHAUSTED')
  })

  it('maps error_during_execution to FATAL_FAILURE', () => {
    expect(toAgentOutcome(resultError('error_during_execution'))).toBe('FATAL_FAILURE')
  })

  it('maps error_max_structured_output_retries to FATAL_FAILURE', () => {
    expect(toAgentOutcome(resultError('error_max_structured_output_retries'))).toBe('FATAL_FAILURE')
  })
})

describe('toUsageRecord', () => {
  it('translates SDK usage, cost, duration, and turns', () => {
    const record = toUsageRecord(resultSuccess(), 'claude-fable-5')
    expect(record).toEqual({
      provider: 'claude-code',
      model: 'claude-fable-5',
      tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: 0.05,
      durationMs: 1234,
      turns: 2,
      subagents: 0,
    })
  })
})

describe('resultSummary', () => {
  it('uses the result text on success', () => {
    expect(resultSummary(resultSuccess({ result: 'all done' }))).toBe('all done')
  })

  it('joins error messages on failure', () => {
    expect(
      resultSummary(resultError('error_during_execution', { errors: ['boom', 'again'] })),
    ).toBe('boom\nagain')
  })
})
