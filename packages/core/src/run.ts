/**
 * Orchestration run entity and state machines.
 *
 * Transitions are validated centrally so every state change is legal,
 * persisted, and observable. Illegal transitions throw.
 */

import type { AgentOutcome } from './agent.js'
import type { UsageRecord } from './budget.js'
import type { RunId, SessionId, WorkItemId, WorkspaceId } from './ids.js'

export const RunState = {
  Queued: 'QUEUED',
  Preparing: 'PREPARING',
  Running: 'RUNNING',
  WaitingForTool: 'WAITING_FOR_TOOL',
  WaitingForSubagent: 'WAITING_FOR_SUBAGENT',
  WaitingForHuman: 'WAITING_FOR_HUMAN',
  Verifying: 'VERIFYING',
  Completed: 'COMPLETED',
  Failed: 'FAILED',
  Blocked: 'BLOCKED',
  Cancelled: 'CANCELLED',
} as const

export type RunState = (typeof RunState)[keyof typeof RunState]

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  RunState.Completed,
  RunState.Failed,
  RunState.Blocked,
  RunState.Cancelled,
]

const ACTIVE: readonly RunState[] = [
  RunState.Running,
  RunState.WaitingForTool,
  RunState.WaitingForSubagent,
  RunState.WaitingForHuman,
  RunState.Verifying,
]

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  [RunState.Queued]: [RunState.Preparing, RunState.Cancelled, RunState.Failed],
  [RunState.Preparing]: [RunState.Running, RunState.Failed, RunState.Cancelled],
  [RunState.Running]: [
    RunState.WaitingForTool,
    RunState.WaitingForSubagent,
    RunState.WaitingForHuman,
    RunState.Verifying,
    RunState.Completed,
    RunState.Failed,
    RunState.Blocked,
    RunState.Cancelled,
  ],
  [RunState.WaitingForTool]: [RunState.Running, RunState.Failed, RunState.Cancelled],
  [RunState.WaitingForSubagent]: [RunState.Running, RunState.Failed, RunState.Cancelled],
  [RunState.WaitingForHuman]: [RunState.Running, RunState.Blocked, RunState.Cancelled],
  [RunState.Verifying]: [RunState.Running, RunState.Completed, RunState.Failed, RunState.Cancelled],
  [RunState.Completed]: [],
  [RunState.Failed]: [RunState.Queued],
  [RunState.Blocked]: [RunState.Queued, RunState.Cancelled],
  [RunState.Cancelled]: [RunState.Queued],
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`illegal run transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}

export function isActive(state: RunState): boolean {
  return ACTIVE.includes(state)
}

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
}

/** Map an agent's terminal outcome onto the run state machine. */
export function runStateForOutcome(outcome: AgentOutcome): RunState {
  switch (outcome) {
    case 'GOAL_COMPLETED':
      return RunState.Completed
    case 'CANCELLED':
      return RunState.Cancelled
    case 'HUMAN_INPUT_REQUIRED':
      return RunState.WaitingForHuman
    case 'GOAL_BLOCKED':
    case 'POLICY_BLOCKED':
      return RunState.Blocked
    case 'BUDGET_EXHAUSTED':
    case 'FATAL_FAILURE':
      return RunState.Failed
  }
}

export interface RunStateChange {
  readonly from: RunState
  readonly to: RunState
  readonly at: Date
  readonly reason?: string
}

/** One orchestration run: a work item travelling through a workflow. */
export interface Run {
  readonly id: RunId
  readonly workItemId: WorkItemId
  readonly workflowName: string
  readonly state: RunState
  readonly currentStepId?: string
  readonly workspaceId?: WorkspaceId
  readonly sessionIds: readonly SessionId[]
  readonly usage?: UsageRecord
  readonly outcome?: AgentOutcome
  readonly error?: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly history: readonly RunStateChange[]
}
