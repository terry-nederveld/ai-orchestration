import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isActive,
  isTerminal,
  RunState,
  runStateForOutcome,
} from './run.js'

describe('run state machine', () => {
  it('allows the happy path', () => {
    assertTransition(RunState.Queued, RunState.Preparing)
    assertTransition(RunState.Preparing, RunState.Running)
    assertTransition(RunState.Running, RunState.Verifying)
    assertTransition(RunState.Verifying, RunState.Completed)
  })

  it('rejects transitions out of completed', () => {
    for (const to of Object.values(RunState)) {
      expect(canTransition(RunState.Completed, to)).toBe(false)
    }
  })

  it('allows requeue after failure, block, or cancellation', () => {
    expect(canTransition(RunState.Failed, RunState.Queued)).toBe(true)
    expect(canTransition(RunState.Blocked, RunState.Queued)).toBe(true)
    expect(canTransition(RunState.Cancelled, RunState.Queued)).toBe(true)
  })

  it('throws IllegalTransitionError with details', () => {
    expect(() => assertTransition(RunState.Queued, RunState.Verifying)).toThrow(
      IllegalTransitionError,
    )
  })

  it('classifies states', () => {
    expect(isTerminal(RunState.Completed)).toBe(true)
    expect(isTerminal(RunState.Running)).toBe(false)
    expect(isActive(RunState.WaitingForHuman)).toBe(true)
    expect(isActive(RunState.Queued)).toBe(false)
  })

  it('maps agent outcomes to run states', () => {
    expect(runStateForOutcome('GOAL_COMPLETED')).toBe(RunState.Completed)
    expect(runStateForOutcome('GOAL_BLOCKED')).toBe(RunState.Blocked)
    expect(runStateForOutcome('POLICY_BLOCKED')).toBe(RunState.Blocked)
    expect(runStateForOutcome('BUDGET_EXHAUSTED')).toBe(RunState.Failed)
    expect(runStateForOutcome('FATAL_FAILURE')).toBe(RunState.Failed)
    expect(runStateForOutcome('HUMAN_INPUT_REQUIRED')).toBe(RunState.WaitingForHuman)
    expect(runStateForOutcome('CANCELLED')).toBe(RunState.Cancelled)
  })
})
