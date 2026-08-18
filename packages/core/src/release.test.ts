import { describe, expect, it } from 'vitest'
import type { RunId, WorkItemId } from './ids.js'
import { asId } from './ids.js'
import {
  advanceReleaseProgress,
  initialReleaseProgress,
  RELEASE_STAGE_ORDER,
  type ReleaseSignal,
  ReleaseStage,
} from './release.js'

const runId = asId('run-1') as RunId
const itemId = asId('github:1') as WorkItemId

function signal(stage: ReleaseStage, at = new Date('2026-08-18T10:00:00Z')): ReleaseSignal {
  return { runId, workItemId: itemId, stage, at, derivedFrom: 'test' }
}

describe('release lifecycle progress', () => {
  it('orders every stage forward from implemented to verified', () => {
    expect(RELEASE_STAGE_ORDER).toEqual([
      'implemented',
      'pr-opened',
      'merged',
      'released',
      'deployed',
      'verified',
    ])
  })

  it('advances monotonically through observed stages', () => {
    let progress = initialReleaseProgress(runId, itemId)
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.Implemented))
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.PrOpened))
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.Merged))
    expect(progress.currentStage).toBe('merged')
    expect(Object.keys(progress.reached)).toHaveLength(3)
  })

  it('never regresses on out-of-order or replayed signals', () => {
    let progress = initialReleaseProgress(runId, itemId)
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.Deployed))
    // A late-arriving earlier-stage signal fills evidence without regressing.
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.Merged))
    expect(progress.currentStage).toBe('deployed')
    expect(progress.reached.merged).toBeDefined()
    // A replay of an already-reached stage is ignored (first signal kept).
    const replay = advanceReleaseProgress(progress, {
      ...signal(ReleaseStage.Deployed),
      derivedFrom: 'replay',
    })
    expect(replay).toBe(progress)
    expect(replay.reached.deployed?.derivedFrom).toBe('test')
  })

  it('keeps stages sparse: only what the connected systems can report', () => {
    let progress = initialReleaseProgress(runId, itemId)
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.PrOpened))
    progress = advanceReleaseProgress(progress, signal(ReleaseStage.Verified))
    expect(progress.currentStage).toBe('verified')
    expect(progress.reached.merged).toBeUndefined()
  })
})
