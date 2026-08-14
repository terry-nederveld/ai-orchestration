import { describe, expect, it } from 'vitest'
import type { CodexItem } from './codex-types.js'
import { fromItemEvent, toUsageRecord } from './mapping.js'

describe('fromItemEvent', () => {
  it('maps a completed agent_message item to agent.text', () => {
    const item: CodexItem = { id: 'item_0', type: 'agent_message', text: 'pong' }
    expect(fromItemEvent('completed', item)).toEqual([{ type: 'agent.text', text: 'pong' }])
  })

  it('emits nothing for a started agent_message (never observed, defensive no-op)', () => {
    const item: CodexItem = { id: 'item_0', type: 'agent_message', text: 'pong' }
    expect(fromItemEvent('started', item)).toEqual([])
  })

  it('maps a started command_execution to agent.tool.started', () => {
    const item: CodexItem = {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/zsh -lc ls',
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    }
    expect(fromItemEvent('started', item)).toEqual([
      {
        type: 'agent.tool.started',
        toolCallId: 'item_1',
        toolName: 'command_execution',
        input: { command: '/bin/zsh -lc ls' },
      },
    ])
  })

  it('maps a completed successful command_execution to agent.tool.completed with isError false', () => {
    const item: CodexItem = {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/zsh -lc ls',
      aggregated_output: 'a.txt\n',
      exit_code: 0,
      status: 'completed',
    }
    expect(fromItemEvent('completed', item)).toEqual([
      {
        type: 'agent.tool.completed',
        toolCallId: 'item_1',
        toolName: 'command_execution',
        isError: false,
        content: 'a.txt\n',
      },
    ])
  })

  it('maps a completed failing command_execution to agent.tool.completed with isError true', () => {
    const item: CodexItem = {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/zsh -lc false',
      aggregated_output: '',
      exit_code: 1,
      status: 'completed',
    }
    const [event] = fromItemEvent('completed', item)
    expect(event).toMatchObject({ isError: true })
  })

  it('maps a completed file_change item to agent.tool.completed with the changes serialized', () => {
    const item: CodexItem = {
      id: 'item_2',
      type: 'file_change',
      changes: [{ path: '/tmp/hello.txt', kind: 'add' }],
      status: 'completed',
    }
    expect(fromItemEvent('completed', item)).toEqual([
      {
        type: 'agent.tool.completed',
        toolCallId: 'item_2',
        toolName: 'file_change',
        isError: false,
        content: JSON.stringify([{ path: '/tmp/hello.txt', kind: 'add' }]),
      },
    ])
  })

  it('maps a completed error item to an advisory agent.text', () => {
    const item: CodexItem = { id: 'item_0', type: 'error', message: 'model metadata not found' }
    expect(fromItemEvent('completed', item)).toEqual([
      { type: 'agent.text', text: '[codex] model metadata not found' },
    ])
  })

  it('reports unrecognized item types generically instead of dropping them', () => {
    const item = { id: 'item_9', type: 'future_thing', detail: 'x' } as unknown as CodexItem
    const [event] = fromItemEvent('started', item)
    expect(event).toMatchObject({
      type: 'agent.tool.started',
      toolCallId: 'item_9',
      toolName: 'future_thing',
    })
  })
})

describe('toUsageRecord', () => {
  it('translates codex usage fields into a core UsageRecord', () => {
    const record = toUsageRecord(
      {
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
      'gpt-5-codex',
      1500,
      2,
    )
    expect(record).toEqual({
      provider: 'codex',
      model: 'gpt-5-codex',
      tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 },
      subscriptionRequests: 2,
      durationMs: 1500,
      turns: 2,
      subagents: 0,
    })
  })
})
