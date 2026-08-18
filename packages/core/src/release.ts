/**
 * Release/deployment lifecycle representation (mission §24): the stages a
 * delivered change moves through after implementation — PR opened, merged,
 * released, deployed, verified — where the connected systems can report
 * them. Signals are derived by adapters/extensions (SCM, CI/CD, issue
 * fields) through the ReleaseSignalSource port; the model itself is a pure
 * monotonic reducer so progress survives replays and out-of-order signals.
 *
 * Workflows may continue past merge by suspending on 'external-event'
 * waits (ADR-0019) keyed to these stages: implement → PR → merge → deploy
 * → wait → observe → verify → complete.
 */

import type { RunId, WorkItemId } from './ids.js'

export const ReleaseStage = {
  Implemented: 'implemented',
  PrOpened: 'pr-opened',
  Merged: 'merged',
  Released: 'released',
  Deployed: 'deployed',
  Verified: 'verified',
} as const

export type ReleaseStage = (typeof ReleaseStage)[keyof typeof ReleaseStage]

/** Canonical forward order; progress never moves backwards. */
export const RELEASE_STAGE_ORDER: readonly ReleaseStage[] = [
  ReleaseStage.Implemented,
  ReleaseStage.PrOpened,
  ReleaseStage.Merged,
  ReleaseStage.Released,
  ReleaseStage.Deployed,
  ReleaseStage.Verified,
]

export interface ReleaseEvidence {
  /** PR/release/deploy URL when the reporting system has one. */
  readonly url?: string
  readonly sha?: string
  readonly tag?: string
  readonly deployId?: string
  readonly note?: string
}

export interface ReleaseSignal {
  readonly runId: RunId
  readonly workItemId: WorkItemId
  readonly stage: ReleaseStage
  readonly at: Date
  readonly evidence?: ReleaseEvidence
  /** Where the signal came from: 'scm:github', 'ci:actions', 'manual', … */
  readonly derivedFrom: string
}

export interface ReleaseProgress {
  readonly runId: RunId
  readonly workItemId: WorkItemId
  /** First accepted signal per stage (evidence of when it was reached). */
  readonly reached: Readonly<Partial<Record<ReleaseStage, ReleaseSignal>>>
  /** Furthest stage reached, by canonical order. */
  readonly currentStage?: ReleaseStage
}

export function initialReleaseProgress(runId: RunId, workItemId: WorkItemId): ReleaseProgress {
  return { runId, workItemId, reached: {} }
}

export function stageIndex(stage: ReleaseStage): number {
  return RELEASE_STAGE_ORDER.indexOf(stage)
}

/**
 * Fold a signal into progress. Monotonic and idempotent: a stage's first
 * signal is kept (later duplicates ignored), and the current stage only
 * ever advances — an out-of-order or replayed earlier-stage signal fills
 * in its evidence without regressing the current stage.
 */
export function advanceReleaseProgress(
  progress: ReleaseProgress,
  signal: ReleaseSignal,
): ReleaseProgress {
  if (progress.reached[signal.stage]) return progress
  const reached = { ...progress.reached, [signal.stage]: signal }
  const currentIndex = progress.currentStage ? stageIndex(progress.currentStage) : -1
  const currentStage =
    stageIndex(signal.stage) > currentIndex ? signal.stage : progress.currentStage
  return {
    ...progress,
    reached,
    ...(currentStage !== undefined ? { currentStage } : {}),
  }
}

/**
 * Port for adapters/extensions that can derive release signals from the
 * systems they integrate (SCM merge status, CI/CD deployments, issue
 * fields). Optional capability — orchestrators poll where available and
 * satisfy 'external-event' waits keyed `release:<stage>` on new signals.
 */
export interface ReleaseSignalSource {
  readonly id: string
  /** Signals observed since the given time for the run's delivery. */
  poll(input: {
    readonly runId: RunId
    readonly workItemId: WorkItemId
    readonly since?: Date
  }): Promise<readonly ReleaseSignal[]>
}
