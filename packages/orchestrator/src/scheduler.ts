/**
 * Scheduler: periodic work discovery, workflow matching, idempotent claiming,
 * and bounded-concurrency dispatch to the RunCoordinator. Also performs
 * restart recovery for runs interrupted mid-flight.
 */

import type {
  Clock,
  EventBus,
  IdGenerator,
  Logger,
  PersistenceProvider,
  Run,
  WorkflowDefinition,
  WorkflowProvider,
  WorkItem,
  WorkProvider,
  WorkQuery,
} from '@overture/core'
import { asId, isTerminal, RunState } from '@overture/core'
import { selectWorkflow } from './eligibility.js'
import type { RunCoordinator } from './run-coordinator.js'

export interface SchedulerOptions {
  readonly sources: ReadonlyArray<{ readonly provider: WorkProvider; readonly query?: WorkQuery }>
  readonly workflows: WorkflowProvider
  readonly coordinator: RunCoordinator
  readonly persistence: PersistenceProvider
  readonly events: EventBus
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly discoveryQuery?: WorkQuery
  readonly pollIntervalMs?: number
  readonly maxConcurrentRuns?: number
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly running = new Set<Promise<void>>()
  private stopped = true

  constructor(private readonly options: SchedulerOptions) {}

  get activeRunCount(): number {
    return this.running.size
  }

  /** Recover interrupted runs, then begin polling for work. */
  async start(): Promise<void> {
    this.stopped = false
    await this.recover()
    const interval = this.options.pollIntervalMs ?? 60_000
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        this.options.logger.error('scheduler tick failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }, interval)
    this.timer.unref?.()
    await this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await Promise.allSettled([...this.running])
  }

  /**
   * Mark runs that were active when the process died. They become FAILED
   * with an interruption reason and can be re-queued explicitly.
   */
  private async recover(): Promise<void> {
    const runs = await this.options.persistence.runs.list()
    for (const run of runs) {
      if (isTerminal(run.state) || run.state === RunState.Queued) continue
      const now = this.options.clock.now()
      const interrupted: Run = {
        ...run,
        state: RunState.Failed,
        updatedAt: now,
        error: 'interrupted by orchestrator restart',
        history: [
          ...run.history,
          { from: run.state, to: RunState.Failed, at: now, reason: 'interrupted by restart' },
        ],
      }
      await this.options.persistence.runs.save(interrupted)
      await this.options.persistence.claims.release(run.workItemId, run.id).catch(() => {})
      this.options.logger.warn('recovered interrupted run', { runId: String(run.id) })
    }
  }

  /** One discovery cycle. Public for tests and manual triggering. */
  async tick(): Promise<void> {
    if (this.stopped) return
    const max = this.options.maxConcurrentRuns ?? 2
    if (this.running.size >= max) return

    const definitions = await this.options.workflows.list()
    if (definitions.length === 0) return

    for (const source of this.options.sources) {
      let items: readonly WorkItem[]
      try {
        items = await source.provider.discover(source.query ?? this.options.discoveryQuery ?? {})
      } catch (error) {
        this.options.logger.warn('work discovery failed', {
          provider: source.provider.info.id,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      for (const item of items) {
        if (this.stopped || this.running.size >= max) return
        this.publishDiscovered(item)
        const definition = selectWorkflow(item, definitions)
        if (!definition) continue
        await this.dispatch(item, definition)
      }
    }
  }

  /** Claim and launch a specific item (used by tick and by manual `run`). */
  async dispatch(item: WorkItem, definition: WorkflowDefinition): Promise<Run | undefined> {
    const runId = asId<'run'>(this.options.ids.next('run'))
    const claimed = await this.options.persistence.claims.tryClaim(item.id, runId)
    if (!claimed) {
      this.options.events.publish({
        id: asId(this.options.ids.next('evt')),
        at: this.options.clock.now(),
        type: 'work.claim.rejected',
        workItemId: String(item.id),
        reason: 'already claimed by an active run',
      })
      return undefined
    }
    this.options.events.publish({
      id: asId(this.options.ids.next('evt')),
      at: this.options.clock.now(),
      runId,
      type: 'work.claimed',
      workItemId: String(item.id),
    })

    const execution = this.options.coordinator
      .execute(item, definition, runId)
      .then(() => {})
      .catch((error) =>
        this.options.logger.error('run execution failed', {
          runId: String(runId),
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    const tracked = execution.finally(() => this.running.delete(tracked))
    this.running.add(tracked)
    await Promise.resolve()
    return undefined
  }

  private publishDiscovered(item: WorkItem): void {
    this.options.events.publish({
      id: asId(this.options.ids.next('evt')),
      at: this.options.clock.now(),
      type: 'work.discovered',
      workItemId: String(item.id),
      provider: item.provider,
    })
  }
}
