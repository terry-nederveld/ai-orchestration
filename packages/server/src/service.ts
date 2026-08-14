/**
 * OvertureService: the application layer. Every capability the product
 * exposes — to the CLI, the desktop UI, or a future remote control plane —
 * is a method here. Transport code (HTTP) contains no logic of its own.
 */

import type {
  AgentProvider,
  Clock,
  EventBus,
  IdGenerator,
  Logger,
  ModelProvider,
  OrchestratorEvent,
  PersistenceProvider,
  ProviderAvailability,
  ProviderInfo,
  Run,
  RunId,
  UsageRecord,
  WorkflowDefinition,
  WorkflowProvider,
  WorkItem,
  WorkProvider,
  WorkQuery,
} from '@overture/core'
import { asId, RunState } from '@overture/core'
import type { RunCoordinator, Scheduler } from '@overture/orchestrator'
import { selectWorkflow } from '@overture/orchestrator'
import { parseWorkflowYaml, WorkflowValidationError } from '@overture/workflow'
import type { ApprovalBroker, PendingApproval } from './approvals.js'

export interface ProviderStatus {
  readonly info: ProviderInfo
  readonly availability: ProviderAvailability
}

export interface ServiceStatus {
  readonly version: string
  readonly startedAt: Date
  readonly activeRuns: number
  readonly workSources: readonly string[]
  readonly workflows: readonly string[]
}

export interface OvertureServiceDeps {
  readonly version: string
  readonly persistence: PersistenceProvider
  readonly events: EventBus
  readonly scheduler: Scheduler
  readonly coordinator: RunCoordinator
  readonly workflows: WorkflowProvider
  readonly workProviders: ReadonlyMap<string, WorkProvider>
  readonly modelProviders: readonly ModelProvider[]
  readonly agentProviders: readonly AgentProvider[]
  readonly approvals: ApprovalBroker
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
}

export class OvertureService {
  private startedAt: Date
  private unsubscribeEventLog: () => void

  constructor(private readonly deps: OvertureServiceDeps) {
    this.startedAt = deps.clock.now()
    // Persist every bus event into the append-only event log.
    this.unsubscribeEventLog = deps.events.subscribe({}, (event) => {
      void deps.persistence.events.append(event).catch((error) => {
        deps.logger.warn('event log append failed', {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
  }

  async start(): Promise<void> {
    this.startedAt = this.deps.clock.now()
    await this.deps.scheduler.start()
  }

  async stop(): Promise<void> {
    await this.deps.scheduler.stop()
    this.unsubscribeEventLog()
    await this.deps.persistence.close()
  }

  async status(): Promise<ServiceStatus> {
    const workflows = await this.deps.workflows.list()
    return {
      version: this.deps.version,
      startedAt: this.startedAt,
      activeRuns: this.deps.scheduler.activeRunCount,
      workSources: [...this.deps.workProviders.keys()],
      workflows: workflows.map((definition) => definition.name),
    }
  }

  // ----- runs ------------------------------------------------------------

  listRuns(filter?: {
    readonly states?: readonly string[]
    readonly limit?: number
  }): Promise<readonly Run[]> {
    return this.deps.persistence.runs.list(filter ?? {})
  }

  getRun(id: string): Promise<Run | undefined> {
    return this.deps.persistence.runs.get(asId<'run'>(id))
  }

  runEvents(id: string, afterEventId?: string): Promise<readonly OrchestratorEvent[]> {
    return this.deps.persistence.events.listForRun(asId<'run'>(id), afterEventId)
  }

  async cancelRun(id: string): Promise<boolean> {
    return this.deps.coordinator.cancel(asId<'run'>(id))
  }

  /** Re-queue a failed/blocked/cancelled run as a fresh attempt. */
  async retryRun(id: string): Promise<Run> {
    const run = await this.getRun(id)
    if (!run) throw new Error(`no run with id ${id}`)
    const retryable: readonly RunState[] = [RunState.Failed, RunState.Blocked, RunState.Cancelled]
    if (!retryable.includes(run.state)) {
      throw new Error(`run ${id} is ${run.state}; only failed, blocked, or cancelled runs retry`)
    }
    const { item, definition } = await this.resolveRunInputs(run)
    return this.launch(item, definition)
  }

  /**
   * Manually run a work item: `sourceId:externalId`, optionally forcing a
   * workflow by name (otherwise trigger/eligibility matching applies).
   */
  async triggerRun(workItemRef: string, workflowName?: string): Promise<Run> {
    const { provider, externalId } = this.parseWorkRef(workItemRef)
    const item = await provider.get(externalId)
    const definitions = await this.deps.workflows.list()
    const definition = workflowName
      ? definitions.find((candidate) => candidate.name === workflowName)
      : (selectWorkflow(item, definitions) ?? definitions[0])
    if (!definition) {
      throw new Error(workflowName ? `no workflow named '${workflowName}'` : 'no eligible workflow')
    }
    return this.launch(item, definition)
  }

  private async launch(item: WorkItem, definition: WorkflowDefinition): Promise<Run> {
    const runId = asId<'run'>(this.deps.ids.next('run'))
    const claimed = await this.deps.persistence.claims.tryClaim(item.id, runId)
    if (!claimed) {
      const holder = await this.deps.persistence.claims.activeClaim(item.id)
      throw new Error(`work item ${String(item.id)} is claimed by run ${String(holder)}`)
    }
    // Fire and forget; callers follow progress via events.
    void this.deps.coordinator.execute(item, definition, runId).catch((error) => {
      this.deps.logger.error('manual run failed', {
        runId: String(runId),
        error: error instanceof Error ? error.message : String(error),
      })
    })
    const run = await this.deps.persistence.runs.get(runId)
    if (run) return run
    return {
      id: runId,
      workItemId: item.id,
      workflowName: definition.name,
      state: RunState.Queued,
      sessionIds: [],
      createdAt: this.deps.clock.now(),
      updatedAt: this.deps.clock.now(),
      history: [],
    }
  }

  private async resolveRunInputs(run: Run) {
    const { provider, externalId } = this.parseWorkRef(String(run.workItemId))
    const item = await provider.get(externalId)
    const definitions = await this.deps.workflows.list()
    const definition = definitions.find((candidate) => candidate.name === run.workflowName)
    if (!definition) throw new Error(`workflow '${run.workflowName}' no longer exists`)
    return { item, definition }
  }

  private parseWorkRef(ref: string): { provider: WorkProvider; externalId: string } {
    const separator = ref.indexOf(':')
    if (separator === -1) {
      const only = [...this.deps.workProviders.values()]
      if (only.length === 1 && only[0]) return { provider: only[0], externalId: ref }
      throw new Error(`work item reference '${ref}' must be '<source>:<id>'`)
    }
    const sourceId = ref.slice(0, separator)
    const externalId = ref.slice(separator + 1)
    const provider = this.deps.workProviders.get(sourceId)
    if (!provider) throw new Error(`unknown work source '${sourceId}'`)
    return { provider, externalId }
  }

  // ----- work ------------------------------------------------------------

  async listWorkItems(sourceId: string, query?: WorkQuery): Promise<readonly WorkItem[]> {
    const provider = this.deps.workProviders.get(sourceId)
    if (!provider) throw new Error(`unknown work source '${sourceId}'`)
    return provider.discover(query ?? {})
  }

  // ----- workflows -------------------------------------------------------

  listWorkflows(): Promise<readonly WorkflowDefinition[]> {
    return this.deps.workflows.list()
  }

  validateWorkflowYaml(source: string): { valid: boolean; issues: readonly string[] } {
    try {
      parseWorkflowYaml(source)
      return { valid: true, issues: [] }
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        return {
          valid: false,
          issues: error.issues.map((issue) => `${issue.path}: ${issue.message}`),
        }
      }
      return { valid: false, issues: [error instanceof Error ? error.message : String(error)] }
    }
  }

  // ----- providers -------------------------------------------------------

  async listProviders(): Promise<readonly ProviderStatus[]> {
    const statuses: ProviderStatus[] = []
    const probes: Array<{ info: ProviderInfo; detect: () => Promise<ProviderAvailability> }> = [
      ...this.deps.modelProviders.map((provider) => ({
        info: provider.info,
        detect: () => provider.detect(),
      })),
      ...this.deps.agentProviders.map((provider) => ({
        info: provider.info,
        detect: () => provider.detect(),
      })),
      ...[...this.deps.workProviders.values()].map((provider) => ({
        info: provider.info,
        detect: () => provider.detect(),
      })),
    ]
    for (const probe of probes) {
      try {
        statuses.push({ info: probe.info, availability: await probe.detect() })
      } catch (error) {
        statuses.push({
          info: probe.info,
          availability: {
            installed: false,
            authenticated: false,
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
    return statuses
  }

  // ----- approvals -------------------------------------------------------

  listApprovals(): readonly PendingApproval[] {
    return this.deps.approvals.list()
  }

  resolveApproval(id: string, approved: boolean): boolean {
    return this.deps.approvals.resolve(id, approved)
  }

  // ----- usage -----------------------------------------------------------

  usageTotals(periodStart: Date, periodEnd: Date): Promise<readonly UsageRecord[]> {
    return this.deps.persistence.usage.totalsForPeriod(periodStart, periodEnd)
  }

  // ----- events ----------------------------------------------------------

  subscribe(handler: (event: OrchestratorEvent) => void, runId?: string): () => void {
    return this.deps.events.subscribe(runId ? { runId: asId<'run'>(runId) } : {}, handler)
  }

  async cancelAllActive(): Promise<void> {
    for (const id of this.deps.coordinator.activeRunIds()) {
      await this.deps.coordinator.cancel(asId<'run'>(id), 'daemon shutdown')
    }
  }
}
