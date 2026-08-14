/**
 * Budgets and usage accounting.
 *
 * Consumption is a first-class concern: every run tracks tokens, estimated
 * cost, subscription request counts, wall-clock time, turns, and sub-agents,
 * and budgets bound each dimension.
 */

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export const emptyTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
}

/** Accumulated consumption for a run, session, or period. */
export interface UsageRecord {
  readonly provider: string
  readonly model?: string
  readonly tokens: TokenUsage
  /** Estimated USD cost for api-usage providers; undefined when unknowable. */
  readonly estimatedCostUsd?: number
  /** Requests consumed against a subscription quota, where measurable. */
  readonly subscriptionRequests?: number
  readonly durationMs: number
  readonly turns: number
  readonly subagents: number
}

/**
 * Limits for one budget scope. All fields optional; absent means unbounded on
 * that dimension. Periodic limits (daily/weekly/monthly) are expressed as
 * separate budgets attached to a period.
 */
export interface BudgetLimits {
  readonly maxConcurrentAgents?: number
  readonly maxSubagentsPerRun?: number
  readonly maxIterations?: number
  readonly maxWallClockMs?: number
  readonly maxTokens?: number
  readonly maxEstimatedCostUsd?: number
  readonly maxSubscriptionRequests?: number
  /** Provider-specific quota keys, e.g. `copilot.premium-requests`. */
  readonly providerQuotas?: Readonly<Record<string, number>>
}

export type BudgetPeriod = 'run' | 'day' | 'week' | 'month'

export interface Budget {
  readonly id: string
  readonly period: BudgetPeriod
  readonly limits: BudgetLimits
}

export type BudgetDimension = keyof Omit<BudgetLimits, 'providerQuotas'> | `providerQuota:${string}`

export interface BudgetStatus {
  readonly budgetId: string
  readonly exhausted: boolean
  /** Dimensions at or beyond their limit. */
  readonly exhaustedDimensions: readonly BudgetDimension[]
  /** Dimensions past the warning threshold (default 80%). */
  readonly warningDimensions: readonly BudgetDimension[]
}

export interface BudgetConsumption {
  readonly tokens?: number
  readonly estimatedCostUsd?: number
  readonly subscriptionRequests?: number
  readonly iterations?: number
  readonly wallClockMs?: number
  readonly providerQuotas?: Readonly<Record<string, number>>
}

/**
 * Budget accounting for a single scope. Pure and deterministic; the caller
 * supplies consumption deltas.
 */
export class BudgetTracker {
  private tokens = 0
  private costUsd = 0
  private requests = 0
  private iterations = 0
  private wallClockMs = 0
  private readonly quotas = new Map<string, number>()

  constructor(
    private readonly budget: Budget,
    private readonly warningRatio = 0.8,
  ) {}

  record(delta: BudgetConsumption): BudgetStatus {
    this.tokens += delta.tokens ?? 0
    this.costUsd += delta.estimatedCostUsd ?? 0
    this.requests += delta.subscriptionRequests ?? 0
    this.iterations += delta.iterations ?? 0
    this.wallClockMs = Math.max(this.wallClockMs, delta.wallClockMs ?? 0)
    for (const [key, value] of Object.entries(delta.providerQuotas ?? {})) {
      this.quotas.set(key, (this.quotas.get(key) ?? 0) + value)
    }
    return this.status()
  }

  status(): BudgetStatus {
    const exhausted: BudgetDimension[] = []
    const warning: BudgetDimension[] = []
    const check = (dimension: BudgetDimension, used: number, limit: number | undefined) => {
      if (limit === undefined) return
      if (used >= limit) exhausted.push(dimension)
      else if (used >= limit * this.warningRatio) warning.push(dimension)
    }
    const limits = this.budget.limits
    check('maxTokens', this.tokens, limits.maxTokens)
    check('maxEstimatedCostUsd', this.costUsd, limits.maxEstimatedCostUsd)
    check('maxSubscriptionRequests', this.requests, limits.maxSubscriptionRequests)
    check('maxIterations', this.iterations, limits.maxIterations)
    check('maxWallClockMs', this.wallClockMs, limits.maxWallClockMs)
    for (const [key, limit] of Object.entries(limits.providerQuotas ?? {})) {
      check(`providerQuota:${key}`, this.quotas.get(key) ?? 0, limit)
    }
    return {
      budgetId: this.budget.id,
      exhausted: exhausted.length > 0,
      exhaustedDimensions: exhausted,
      warningDimensions: warning,
    }
  }
}
