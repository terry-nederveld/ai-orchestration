import { beforeEach, describe, expect, it } from 'vitest'
import type { OrchestratorEvent, OrchestratorEventPayload } from '../../api/types'
import { reduceRunTimeline } from './timeline'

// Reset per test so hardcoded timestamp assertions stay stable regardless of
// test execution order.
let seq = 0
beforeEach(() => {
  seq = 0
})
// Generic (rather than `Omit<OrchestratorEvent, 'id' | 'at'>`) so each call
// site's literal narrows to its specific union member: `Omit` applied to an
// already-intersected discriminated union collapses to only the fields
// common across every variant, which would make every payload-specific
// field (stepId, sessionId, ...) look like a typo.
function ev<T extends OrchestratorEventPayload>(payload: T): OrchestratorEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    ...payload,
  } as OrchestratorEvent
}

describe('reduceRunTimeline', () => {
  it('returns empty model for no events', () => {
    const model = reduceRunTimeline([])
    expect(model).toEqual({
      steps: [],
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    })
  })

  it('ignores event types it does not model', () => {
    const model = reduceRunTimeline([
      ev({ type: 'work.discovered', workItemId: 'w1', provider: 'github' }),
      ev({ type: 'error', scope: 'daemon', message: 'boom' }),
    ])
    expect(model.steps).toEqual([])
    expect(model.transcript).toEqual([])
  })

  describe('step lifecycle', () => {
    it('marks a step running on start and preserves start time', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'plan' }),
      ])
      expect(model.steps).toEqual([
        { stepId: 'plan', status: 'running', startedAt: '2026-01-01T00:00:01Z' },
      ])
    })

    it('transitions a started step to succeeded and records finish time', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'plan' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'plan', status: 'succeeded' }),
      ])
      expect(model.steps).toEqual([
        {
          stepId: 'plan',
          status: 'succeeded',
          startedAt: '2026-01-01T00:00:01Z',
          finishedAt: '2026-01-01T00:00:02Z',
        },
      ])
    })

    it('records failed and skipped outcomes', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'build' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'build', status: 'failed' }),
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'deploy' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'deploy', status: 'skipped' }),
      ])
      expect(model.steps.map((s) => [s.stepId, s.status])).toEqual([
        ['build', 'failed'],
        ['deploy', 'skipped'],
      ])
    })

    it('preserves first-seen step order regardless of completion order', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'a' }),
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'b' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'a', status: 'succeeded' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'b', status: 'succeeded' }),
      ])
      expect(model.steps.map((s) => s.stepId)).toEqual(['a', 'b'])
    })

    it('creates a step entry from a completed event with no prior start (e.g. after truncated history)', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'orphan', status: 'succeeded' }),
      ])
      expect(model.steps).toEqual([
        { stepId: 'orphan', status: 'succeeded', finishedAt: '2026-01-01T00:00:01Z' },
      ])
    })

    it('re-running a step (retry) overwrites status and start time in place', () => {
      const model = reduceRunTimeline([
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'plan' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'plan', status: 'failed' }),
        ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'plan' }),
        ev({ type: 'workflow.step.completed', runId: 'r1', stepId: 'plan', status: 'succeeded' }),
      ])
      expect(model.steps).toHaveLength(1)
      expect(model.steps[0]?.status).toBe('succeeded')
      expect(model.steps[0]?.startedAt).toBe('2026-01-01T00:00:03Z')
    })
  })

  describe('agent text accumulation', () => {
    it('merges consecutive text deltas from the same session into one entry', () => {
      const model = reduceRunTimeline([
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'Hel' } }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'lo, ' } }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'world' } }),
      ])
      expect(model.transcript).toEqual([{ kind: 'text', sessionId: 's1', text: 'Hello, world' }])
    })

    it('does not merge text across different sessions', () => {
      const model = reduceRunTimeline([
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'from s1' } }),
        ev({ type: 'agent', sessionId: 's2', event: { type: 'agent.text', text: 'from s2' } }),
      ])
      expect(model.transcript).toEqual([
        { kind: 'text', sessionId: 's1', text: 'from s1' },
        { kind: 'text', sessionId: 's2', text: 'from s2' },
      ])
    })

    it('starts a new text entry after an intervening tool call', () => {
      const model = reduceRunTimeline([
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'before' } }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.started',
            toolCallId: 't1',
            toolName: 'bash',
            input: { cmd: 'ls' },
          },
        }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.completed',
            toolCallId: 't1',
            toolName: 'bash',
            isError: false,
            content: 'ok',
          },
        }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'after' } }),
      ])
      const kinds = model.transcript.map((entry) => entry.kind)
      expect(kinds).toEqual(['text', 'tool', 'text'])
      expect(model.transcript[0]).toMatchObject({ text: 'before' })
      expect(model.transcript[2]).toMatchObject({ text: 'after' })
    })

    it('accumulates thinking text separately from visible text', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.thinking', text: 'consider ' },
        }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.thinking', text: 'options' } }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'answer' } }),
      ])
      expect(model.transcript).toEqual([
        { kind: 'thinking', sessionId: 's1', text: 'consider options' },
        { kind: 'text', sessionId: 's1', text: 'answer' },
      ])
    })
  })

  describe('tool calls', () => {
    it('renders a running tool call before completion', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.started',
            toolCallId: 't1',
            toolName: 'grep',
            input: { pattern: 'x' },
          },
        }),
      ])
      expect(model.transcript).toEqual([
        {
          kind: 'tool',
          sessionId: 's1',
          call: { toolCallId: 't1', toolName: 'grep', input: { pattern: 'x' }, status: 'running' },
        },
      ])
    })

    it('matches completion to the originating call by toolCallId, not position', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.tool.started', toolCallId: 't1', toolName: 'grep', input: {} },
        }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.tool.started', toolCallId: 't2', toolName: 'read', input: {} },
        }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.completed',
            toolCallId: 't1',
            toolName: 'grep',
            isError: false,
            content: 'first result',
          },
        }),
      ])
      const t1 = model.transcript.find((e) => e.kind === 'tool' && e.call.toolCallId === 't1')
      const t2 = model.transcript.find((e) => e.kind === 'tool' && e.call.toolCallId === 't2')
      expect(t1).toMatchObject({ call: { status: 'succeeded', result: 'first result' } })
      expect(t2).toMatchObject({ call: { status: 'running' } })
    })

    it('marks a failed tool call as failed with its error content', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.tool.started', toolCallId: 't1', toolName: 'bash', input: {} },
        }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.completed',
            toolCallId: 't1',
            toolName: 'bash',
            isError: true,
            content: 'permission denied',
          },
        }),
      ])
      expect(model.transcript[0]).toMatchObject({
        call: { status: 'failed', isError: true, result: 'permission denied' },
      })
    })

    it('ignores a completion event with no matching started call', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.tool.completed',
            toolCallId: 'missing',
            toolName: 'bash',
            isError: false,
            content: 'x',
          },
        }),
      ])
      expect(model.transcript).toEqual([])
    })
  })

  describe('waiting on human and subagents', () => {
    it('records a waiting-human marker with its reason', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.waiting.human', reason: 'need credentials' },
        }),
      ])
      expect(model.transcript).toEqual([
        { kind: 'waiting-human', sessionId: 's1', reason: 'need credentials' },
      ])
    })

    it('tracks subagent lifecycle from started to completed', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: { type: 'agent.subagent.started', childSessionId: 'child-1' },
        }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.subagent.completed',
            childSessionId: 'child-1',
            outcome: 'GOAL_COMPLETED',
          },
        }),
      ])
      expect(model.transcript).toEqual([
        {
          kind: 'subagent',
          sessionId: 's1',
          childSessionId: 'child-1',
          status: 'completed',
          outcome: 'GOAL_COMPLETED',
        },
      ])
    })
  })

  describe('usage aggregation', () => {
    it('sums tokens across agent.usage events and counts turns', () => {
      const model = reduceRunTimeline([
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.turn.started', turn: 1 } }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.usage',
            usage: { inputTokens: 100, outputTokens: 50 },
            model: 'claude',
          },
        }),
        ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.turn.started', turn: 2 } }),
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.usage',
            usage: { inputTokens: 30, outputTokens: 10 },
            model: 'claude',
          },
        }),
      ])
      expect(model.usage).toEqual({ inputTokens: 130, outputTokens: 60, turns: 2 })
    })

    it('aggregates usage across multiple sessions (subagents)', () => {
      const model = reduceRunTimeline([
        ev({
          type: 'agent',
          sessionId: 's1',
          event: {
            type: 'agent.usage',
            usage: { inputTokens: 10, outputTokens: 5 },
            model: 'claude',
          },
        }),
        ev({
          type: 'agent',
          sessionId: 'child-1',
          event: {
            type: 'agent.usage',
            usage: { inputTokens: 20, outputTokens: 8 },
            model: 'claude',
          },
        }),
      ])
      expect(model.usage).toEqual({ inputTokens: 30, outputTokens: 13, turns: 0 })
    })
  })

  it('processes a realistic mixed run end-to-end', () => {
    const model = reduceRunTimeline([
      ev({ type: 'workflow.step.started', runId: 'r1', stepId: 'implement' }),
      ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.started', sessionId: 's1' } }),
      ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.turn.started', turn: 1 } }),
      ev({
        type: 'agent',
        sessionId: 's1',
        event: { type: 'agent.text', text: 'Reading the issue...' },
      }),
      ev({
        type: 'agent',
        sessionId: 's1',
        event: {
          type: 'agent.tool.started',
          toolCallId: 't1',
          toolName: 'read_file',
          input: { path: 'a.ts' },
        },
      }),
      ev({
        type: 'agent',
        sessionId: 's1',
        event: {
          type: 'agent.tool.completed',
          toolCallId: 't1',
          toolName: 'read_file',
          isError: false,
          content: 'export {}',
        },
      }),
      ev({ type: 'agent', sessionId: 's1', event: { type: 'agent.text', text: 'Looks good.' } }),
      ev({
        type: 'agent',
        sessionId: 's1',
        event: {
          type: 'agent.usage',
          usage: { inputTokens: 500, outputTokens: 120 },
          model: 'claude',
        },
      }),
      ev({
        type: 'workflow.step.completed',
        runId: 'r1',
        stepId: 'implement',
        status: 'succeeded',
      }),
    ])

    expect(model.steps).toEqual([
      {
        stepId: 'implement',
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:01Z',
        finishedAt: '2026-01-01T00:00:09Z',
      },
    ])
    expect(model.transcript.map((e) => e.kind)).toEqual(['text', 'tool', 'text'])
    expect(model.usage).toEqual({ inputTokens: 500, outputTokens: 120, turns: 1 })
  })
})
