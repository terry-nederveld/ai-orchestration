/**
 * Persisted graph-execution state (ADR-0017): everything the durable
 * engine needs to resume a run from its exact position — node results with
 * structured outputs, loop counters, fan-out branch progress, domain
 * state, and open waits. Persisted at every tick boundary (a tick runs to
 * its next wait or terminal), so recovery is at-least-once from the last
 * boundary: a crash mid-tick replays the tick's settled nodes.
 */

import type { RunId } from './ids.js'

export type GraphNodeStatus = 'succeeded' | 'failed' | 'skipped'

export interface GraphNodeResult {
  readonly nodeId: string
  /** 1-based attempt number (retries and remediation re-runs increment). */
  readonly attempt: number
  readonly status: GraphNodeStatus
  /** Structured outputs; the transition expressions' `outputs` scope. */
  readonly outputs: Readonly<Record<string, unknown>>
  readonly error?: string
  readonly startedAt: Date
  readonly settledAt: Date
}

export interface DomainState {
  readonly name?: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface FanOutBranchState {
  readonly key: string
  readonly childRunId?: RunId
  readonly status: 'pending' | 'active' | 'succeeded' | 'failed'
  readonly outputs?: Readonly<Record<string, unknown>>
}

export interface FanOutState {
  readonly nodeId: string
  readonly branches: readonly FanOutBranchState[]
}

export interface RunGraphState {
  readonly runId: RunId
  readonly snapshotId: string
  /** Nodes currently executing or waiting (at-most-once activation). */
  readonly activeNodeIds: readonly string[]
  /** Subset of active nodes suspended on an open WaitCondition. */
  readonly waitingNodeIds: readonly string[]
  /** Latest result per node (history preserved in `resultHistory`). */
  readonly nodeResults: Readonly<Record<string, GraphNodeResult>>
  readonly resultHistory: readonly GraphNodeResult[]
  /** Transition id → firing count (loop bounds and join accounting). */
  readonly loopCounters: Readonly<Record<string, number>>
  /** Node id → times activated (join accounting for multi-input nodes). */
  readonly activations: Readonly<Record<string, number>>
  /**
   * Node id → local retry re-executions. Kept separate from activations
   * so retries never skew join/loop accounting (optional for states
   * persisted before the field existed).
   */
  readonly retries?: Readonly<Record<string, number>>
  readonly domain: DomainState
  readonly fanOuts: Readonly<Record<string, FanOutState>>
  readonly variables: Readonly<Record<string, unknown>>
  /** Current ExecutionSpecification revision the run operates under. */
  readonly specRevision: number
  readonly updatedAt: Date
}

export function initialRunGraphState(
  runId: RunId,
  snapshotId: string,
  variables: Readonly<Record<string, unknown>> = {},
): RunGraphState {
  return {
    runId,
    snapshotId,
    activeNodeIds: [],
    waitingNodeIds: [],
    nodeResults: {},
    resultHistory: [],
    loopCounters: {},
    activations: {},
    retries: {},
    domain: { data: {} },
    fanOuts: {},
    variables,
    specRevision: 1,
    updatedAt: new Date(0),
  }
}

export interface RunGraphStateRepository {
  save(state: RunGraphState): Promise<void>
  get(runId: RunId): Promise<RunGraphState | undefined>
  delete(runId: RunId): Promise<void>
}
