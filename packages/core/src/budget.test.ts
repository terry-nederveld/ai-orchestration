import { describe, expect, it } from 'vitest'
import { addTokenUsage, BudgetTracker } from './budget.js'

const budget = (limits: ConstructorParameters<typeof BudgetTracker>[0]['limits']) =>
  new BudgetTracker({ id: 'b1', period: 'run', limits })

describe('BudgetTracker', () => {
  it('reports nothing exhausted for an unbounded budget', () => {
    const tracker = budget({})
    const status = tracker.record({ tokens: 1_000_000, estimatedCostUsd: 999 })
    expect(status.exhausted).toBe(false)
    expect(status.warningDimensions).toEqual([])
  })

  it('warns at 80% and exhausts at the limit', () => {
    const tracker = budget({ maxTokens: 100 })
    expect(tracker.record({ tokens: 79 }).warningDimensions).toEqual([])
    expect(tracker.record({ tokens: 1 }).warningDimensions).toEqual(['maxTokens'])
    const status = tracker.record({ tokens: 20 })
    expect(status.exhausted).toBe(true)
    expect(status.exhaustedDimensions).toEqual(['maxTokens'])
  })

  it('tracks iterations and cost independently', () => {
    const tracker = budget({ maxIterations: 2, maxEstimatedCostUsd: 1 })
    tracker.record({ iterations: 1, estimatedCostUsd: 0.4 })
    const status = tracker.record({ iterations: 1, estimatedCostUsd: 0.4 })
    expect(status.exhaustedDimensions).toEqual(['maxIterations'])
    expect(status.warningDimensions).toEqual(['maxEstimatedCostUsd'])
  })

  it('uses max, not sum, for wall clock', () => {
    const tracker = budget({ maxWallClockMs: 1000 })
    tracker.record({ wallClockMs: 600 })
    expect(tracker.record({ wallClockMs: 700 }).exhausted).toBe(false)
    expect(tracker.record({ wallClockMs: 1000 }).exhausted).toBe(true)
  })

  it('tracks provider-specific quotas', () => {
    const tracker = budget({ providerQuotas: { 'copilot.premium-requests': 2 } })
    tracker.record({ providerQuotas: { 'copilot.premium-requests': 1 } })
    const status = tracker.record({ providerQuotas: { 'copilot.premium-requests': 1 } })
    expect(status.exhaustedDimensions).toEqual(['providerQuota:copilot.premium-requests'])
  })
})

describe('addTokenUsage', () => {
  it('sums all fields treating absent cache counts as zero', () => {
    const sum = addTokenUsage(
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
      { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4 },
    )
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    })
  })
})
