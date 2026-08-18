/**
 * Execution lanes and backlog consumption (mission §22–§23): a lane binds
 * a work source/query to a workflow route with its own ordering,
 * WIP/concurrency, consumption policy, capability constraints, budget,
 * and optional recurring schedule. The backlog's native rank is canonical
 * priority unless the lane overrides ordering.
 */

export type ConsumptionPolicy = 'strict_serial' | 'skip_blocked' | 'ranked_parallel'

export interface LaneDefinition {
  readonly name: string
  readonly description?: string
  /** Work source id (from configuration). */
  readonly source: string
  /** Discovery query overrides for this lane. */
  readonly query?: Readonly<Record<string, unknown>>
  /** Workflow routed to items this lane consumes; omitted = routing. */
  readonly workflow?: string
  readonly policy: ConsumptionPolicy
  /** Max simultaneously active runs in this lane. */
  readonly maxActive: number
  /** Capabilities the executing profile must advertise. */
  readonly requiredCapabilities?: readonly string[]
  /** Profile constraint: only these profiles may serve the lane. */
  readonly allowedProfiles?: readonly string[]
  readonly budgetName?: string
  readonly enabled: boolean
}

export interface ScheduleDefinition {
  readonly name: string
  readonly description?: string
  /** Cron expression (5-field, minute precision). */
  readonly cron: string
  /** Workflow started on each firing. */
  readonly workflow: string
  /** Synthetic work-item payload handed to the run (no external item). */
  readonly payload?: Readonly<Record<string, unknown>>
  readonly enabled: boolean
}

export interface ScheduleFiring {
  readonly scheduleName: string
  readonly dueAt: Date
  readonly firedAt?: Date
  readonly runId?: string
}

export interface ScheduleRepository {
  recordFiring(firing: ScheduleFiring): Promise<void>
  lastFiring(scheduleName: string): Promise<ScheduleFiring | undefined>
}
