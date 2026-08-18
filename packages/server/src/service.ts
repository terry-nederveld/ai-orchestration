/**
 * OvertureService: the application layer. Every capability the product
 * exposes — to the CLI, the desktop UI, or a future remote control plane —
 * is a method here. Transport code (HTTP) contains no logic of its own.
 */

import type {
  AgentProvider,
  Clock,
  DefinitionLifecycle,
  DefinitionStatus,
  DefinitionVersion,
  EventBus,
  GraphIssue,
  IdGenerator,
  JudgmentOutcome,
  Logger,
  ModelProvider,
  OrchestratorEvent,
  PersistenceProvider,
  ProviderAvailability,
  ProviderInfo,
  RepositoryReference,
  Run,
  RunGraphState,
  UsageRecord,
  WaitCondition,
  WaitKind,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowProvider,
  WorkItem,
  WorkProvider,
  WorkQuery,
} from '@overture/core'
import {
  asId,
  DefinitionKind,
  InputValidationFailure,
  OrchestratorError,
  RunState,
  validateGraph,
  validateHumanInputValue,
} from '@overture/core'
import type { EvaluationReport, RunCoordinator, Scheduler } from '@overture/orchestrator'
import { evaluateWorkflow, selectWorkflow } from '@overture/orchestrator'
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

/**
 * Satisfy port of the durable graph runtime (GraphRunCoordinator.satisfy).
 * A narrow structural interface so assemblies without the graph coordinator
 * still typecheck.
 */
export interface GraphWaitCoordinator {
  satisfy(
    waitId: string,
    response: {
      readonly responder: string
      readonly channel: 'app' | 'work_item'
      readonly value?: unknown
      readonly event?: Readonly<Record<string, unknown>>
    },
  ): Promise<{ readonly accepted: boolean; readonly reason?: string }>
}

/** Work-centric view of a durable graph run. */
export interface GraphRunView {
  readonly run?: Run
  /** Persisted graph state with `resultHistory` ordered newest-first. */
  readonly state: RunGraphState
  readonly openWaits: readonly WaitCondition[]
}

export interface DefinitionDetail {
  readonly kind: DefinitionKind
  readonly name: string
  readonly lifecycle: DefinitionLifecycle
  readonly latestVersion: number
  /** The requested (or latest) version, document included. */
  readonly definition: DefinitionVersion
  /** Version history, newest first. */
  readonly versions: ReadonlyArray<Pick<DefinitionVersion, 'version' | 'contentHash' | 'createdAt'>>
}

export type WaitRespondOutcome =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'invalid'; readonly reason: string }
  | {
      readonly outcome: 'conflict'
      readonly reason: string
      /** Summary of the response that won the first-valid-response race. */
      readonly winner?: {
        readonly at: Date
        readonly responder?: string
        readonly channel?: string
        readonly value?: unknown
      }
    }

/** Request body for side-effect-free Evaluate (ADR-0026). */
export interface EvaluateRequest {
  readonly workflowName: string
  readonly version?: number
  /** Work-item reference `<source>:<id>` (or bare id with one source). */
  readonly itemExternalId?: string
  /** Inline hypothetical item, used when no provider fetch is wanted. */
  readonly item?: Readonly<Record<string, unknown>>
  readonly variables?: Readonly<Record<string, unknown>>
  readonly hypotheticalOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type EvaluateOutcome =
  | { readonly outcome: 'ok'; readonly report: EvaluationReport }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  | { readonly outcome: 'invalid'; readonly reason: string }
  | { readonly outcome: 'not-found'; readonly reason: string }

const WAIT_KINDS: readonly WaitKind[] = [
  'human-input',
  'approval',
  'time',
  'external-event',
  'dependency',
  'provider-availability',
  'work-item-event',
]

export function parseWaitKind(raw: string): WaitKind | undefined {
  return (WAIT_KINDS as readonly string[]).includes(raw) ? (raw as WaitKind) : undefined
}

export function parseDefinitionKind(raw: string): DefinitionKind | undefined {
  return (Object.values(DefinitionKind) as readonly string[]).includes(raw)
    ? (raw as DefinitionKind)
    : undefined
}

const LIFECYCLES: readonly DefinitionLifecycle[] = ['draft', 'enabled', 'disabled']

export function parseDefinitionLifecycle(raw: string): DefinitionLifecycle | undefined {
  return (LIFECYCLES as readonly string[]).includes(raw) ? (raw as DefinitionLifecycle) : undefined
}

export interface OvertureServiceDeps {
  readonly version: string
  /**
   * Applied to every event before it is persisted or delivered to
   * subscribers (SSE included), scrubbing secret values (see the security
   * review's SECRETS-PERSIST finding). Identity when omitted.
   */
  readonly redactEvent?: (event: OrchestratorEvent) => OrchestratorEvent
  /**
   * Applied to every control-plane response payload before it leaves the
   * process, scrubbing secret values just like `redactEvent` does for the
   * event stream. Identity when omitted.
   */
  readonly redactPayload?: (payload: unknown) => unknown
  /**
   * Durable graph runtime coordinator (Phase 2). Optional so v1-only
   * assemblies still work; wait responses report 'unavailable' without it.
   */
  readonly graphCoordinator?: GraphWaitCoordinator
  /**
   * Executor-availability probe for side-effect-free Evaluate (ADR-0026),
   * normally backed by the graph runtime's executor registry. Optional so
   * v1-only assemblies still work; POST /api/evaluate reports 'unavailable'
   * without it.
   */
  readonly evaluateExecutors?: { has(executorId: string): boolean }
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
    // Persist every bus event into the append-only event log, redacted.
    this.unsubscribeEventLog = deps.events.subscribe({}, (event) => {
      const sanitized = deps.redactEvent ? deps.redactEvent(event) : event
      void deps.persistence.events.append(sanitized).catch((error) => {
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

  // ----- durable waits (Phase 2) -----------------------------------------

  async listWaits(filter?: {
    readonly runId?: string
    readonly kind?: WaitKind
    readonly reason?: string
  }): Promise<readonly WaitCondition[]> {
    const open = await this.deps.persistence.waits.listOpen({
      ...(filter?.runId ? { runId: asId<'run'>(filter.runId) } : {}),
      ...(filter?.kind ? { kind: filter.kind } : {}),
    })
    const matched = filter?.reason
      ? open.filter((condition) => condition.parameters.reason === filter.reason)
      : open
    return this.redact(matched)
  }

  /**
   * Answer a durable wait. Validates the typed value against the wait's
   * request spec, then submits through the coordinator's satisfy path; the
   * coordinator's CAS gives first-valid-response-wins semantics, and a lost
   * race reports the winning response.
   */
  async respondToWait(
    id: string,
    response: { readonly value: unknown; readonly respondedBy?: string },
  ): Promise<WaitRespondOutcome> {
    const coordinator = this.deps.graphCoordinator
    if (!coordinator) return { outcome: 'unavailable' }
    const condition = await this.deps.persistence.waits.get(id)
    if (!condition) return { outcome: 'not-found' }
    if (condition.request) {
      try {
        validateHumanInputValue(condition.request, response.value)
      } catch (error) {
        if (error instanceof InputValidationFailure) {
          return { outcome: 'invalid', reason: error.message }
        }
        throw error
      }
    }
    const result = await coordinator.satisfy(id, {
      responder: response.respondedBy ?? 'app',
      channel: 'app',
      value: response.value,
    })
    if (result.accepted) return { outcome: 'accepted' }
    const settled = await this.deps.persistence.waits.get(id)
    const winning = settled?.satisfaction
    return this.redact({
      outcome: 'conflict',
      reason: result.reason ?? 'already satisfied',
      ...(winning
        ? {
            winner: {
              at: winning.at,
              ...(winning.input
                ? {
                    responder: winning.input.responder,
                    channel: winning.input.channel,
                    value: winning.input.value,
                  }
                : {}),
            },
          }
        : {}),
    })
  }

  // ----- definitions -----------------------------------------------------

  async listDefinitions(kind?: DefinitionKind): Promise<readonly DefinitionStatus[]> {
    const kinds = kind ? [kind] : Object.values(DefinitionKind)
    const statuses: DefinitionStatus[] = []
    for (const each of kinds) {
      statuses.push(...(await this.deps.persistence.definitions.list(each)))
    }
    return this.redact(statuses)
  }

  async getDefinition(
    kind: DefinitionKind,
    name: string,
    version?: number,
  ): Promise<DefinitionDetail | undefined> {
    const store = this.deps.persistence.definitions
    const definition = await store.get(kind, name, version)
    if (!definition) return undefined
    const [lifecycle, versions] = await Promise.all([
      store.getLifecycle(kind, name),
      store.listVersions(kind, name),
    ])
    const history = [...versions]
      .sort((a, b) => b.version - a.version)
      .map((entry) => ({
        version: entry.version,
        contentHash: entry.contentHash,
        createdAt: entry.createdAt,
      }))
    return this.redact({
      kind,
      name,
      lifecycle,
      latestVersion: history[0]?.version ?? definition.version,
      definition,
      versions: history,
    })
  }

  async saveDefinition(
    kind: DefinitionKind,
    name: string,
    document: Readonly<Record<string, unknown>>,
  ): Promise<DefinitionVersion> {
    return this.redact(await this.deps.persistence.definitions.save(kind, name, document))
  }

  async setDefinitionLifecycle(
    kind: DefinitionKind,
    name: string,
    lifecycle: DefinitionLifecycle,
  ): Promise<DefinitionStatus | undefined> {
    const store = this.deps.persistence.definitions
    const existing = await store.get(kind, name)
    if (!existing) return undefined
    await store.setLifecycle(kind, name, lifecycle)
    return this.redact({ kind, name, lifecycle, latestVersion: existing.version })
  }

  /**
   * Structural validation for a definition document before it is saved.
   * Workflow documents run the same `validateGraph` the engine enforces
   * (ADR-0026: shared validation, not duplicated); other kinds have no
   * structural validator yet and report no issues.
   */
  validateDefinitionDocument(
    kind: DefinitionKind,
    document: Readonly<Record<string, unknown>>,
  ): readonly GraphIssue[] {
    if (kind !== DefinitionKind.Workflow) return []
    const shapeIssues = workflowDocumentShapeIssues(document)
    if (shapeIssues.length > 0) return shapeIssues
    return validateGraph(document as unknown as WorkflowGraph)
  }

  /**
   * Side-effect-free Evaluate (ADR-0026): dry-run a workflow definition
   * against a work item through read-only ports only. Nothing is claimed,
   * persisted, started, or mutated — `evaluateWorkflow` accepts no port
   * that can write.
   */
  async evaluate(request: EvaluateRequest): Promise<EvaluateOutcome> {
    const executors = this.deps.evaluateExecutors
    if (!executors) {
      return {
        outcome: 'unavailable',
        reason: 'evaluate requires the graph runtime, which is not assembled in this daemon',
      }
    }
    for (const [nodeId, outputs] of Object.entries(request.hypotheticalOutputs ?? {})) {
      if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
        return { outcome: 'invalid', reason: `hypotheticalOutputs.${nodeId} must be an object` }
      }
    }

    let item: WorkItem
    let workProvider: WorkProvider | undefined
    if (request.item !== undefined) {
      const normalized = normalizeInlineItem(request.item)
      if (typeof normalized === 'string') return { outcome: 'invalid', reason: normalized }
      item = normalized
      const only = [...this.deps.workProviders.values()]
      if (only.length === 1) workProvider = only[0]
    } else if (request.itemExternalId !== undefined) {
      let ref: { provider: WorkProvider; externalId: string }
      try {
        ref = this.parseWorkRef(request.itemExternalId)
      } catch (error) {
        return {
          outcome: 'invalid',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      try {
        item = await ref.provider.get(ref.externalId)
      } catch {
        return {
          outcome: 'not-found',
          reason: `work item '${request.itemExternalId}' was not found`,
        }
      }
      workProvider = ref.provider
    } else {
      return { outcome: 'invalid', reason: 'itemExternalId or item is required' }
    }

    // Narrow the provider to its read path so evaluate cannot see comment/
    // transition/claim even structurally.
    const provider = workProvider
    const work = provider
      ? { get: (externalId: string, container?: string) => provider.get(externalId, container) }
      : undefined
    try {
      const report = await evaluateWorkflow(
        {
          item,
          workflowName: request.workflowName,
          ...(request.version !== undefined ? { version: request.version } : {}),
          ...(request.variables !== undefined ? { variables: request.variables } : {}),
          ...(request.hypotheticalOutputs !== undefined
            ? { hypotheticalOutputs: request.hypotheticalOutputs }
            : {}),
        },
        {
          definitions: this.deps.persistence.definitions,
          executors,
          ...(work ? { work } : {}),
        },
      )
      return { outcome: 'ok', report: this.redact(report) }
    } catch (error) {
      if (error instanceof OrchestratorError && error.category === 'invalid-input') {
        return { outcome: 'not-found', reason: error.message }
      }
      throw error
    }
  }

  // ----- judgments -------------------------------------------------------

  /** Judgment outcomes in [start, end), newest first, for observability. */
  async listJudgments(start: Date, end: Date): Promise<readonly JudgmentOutcome[]> {
    const outcomes = await this.deps.persistence.judgments.listForPeriod(start, end)
    return this.redact([...outcomes].sort((a, b) => b.at.getTime() - a.at.getTime()))
  }

  // ----- graph runs ------------------------------------------------------

  async getGraphRun(id: string): Promise<GraphRunView | undefined> {
    const runId = asId<'run'>(id)
    const state = await this.deps.persistence.runGraphs.get(runId)
    if (!state) return undefined
    const [run, openWaits] = await Promise.all([
      this.deps.persistence.runs.get(runId),
      this.deps.persistence.waits.listOpen({ runId }),
    ])
    return this.redact({
      ...(run ? { run } : {}),
      state: { ...state, resultHistory: [...state.resultHistory].reverse() },
      openWaits,
    })
  }

  private redact<T>(payload: T): T {
    const redact = this.deps.redactPayload
    return redact ? (redact(payload) as T) : payload
  }

  // ----- events ----------------------------------------------------------

  subscribe(handler: (event: OrchestratorEvent) => void, runId?: string): () => void {
    const redact = this.deps.redactEvent
    const wrapped = redact ? (event: OrchestratorEvent) => handler(redact(event)) : handler
    return this.deps.events.subscribe(runId ? { runId: asId<'run'>(runId) } : {}, wrapped)
  }

  async cancelAllActive(): Promise<void> {
    for (const id of this.deps.coordinator.activeRunIds()) {
      await this.deps.coordinator.cancel(asId<'run'>(id), 'daemon shutdown')
    }
  }
}

/**
 * Pre-flight shape checks so `validateGraph` (which assumes the document
 * already has the WorkflowGraph shape) never dereferences a missing field.
 */
function workflowDocumentShapeIssues(
  document: Readonly<Record<string, unknown>>,
): readonly GraphIssue[] {
  const issues: GraphIssue[] = []
  if (typeof document.name !== 'string' || document.name === '') {
    issues.push({ path: 'name', message: 'name must be a non-empty string' })
  }
  if (typeof document.entry !== 'string' || document.entry === '') {
    issues.push({ path: 'entry', message: 'entry must be a non-empty string' })
  }
  const nodes = document.nodes
  if (!Array.isArray(nodes)) {
    issues.push({ path: 'nodes', message: 'nodes must be an array' })
  } else {
    for (const [index, node] of nodes.entries()) {
      const record =
        node !== null && typeof node === 'object' ? (node as Record<string, unknown>) : undefined
      if (!record || typeof record.id !== 'string' || record.id === '') {
        issues.push({ path: `nodes[${index}]`, message: 'node id must be a non-empty string' })
        continue
      }
      const config = record.config
      const kind =
        config !== null && typeof config === 'object'
          ? (config as Record<string, unknown>).kind
          : undefined
      if (typeof kind !== 'string') {
        issues.push({
          path: `nodes.${record.id}`,
          message: 'node config must declare a kind',
        })
      }
    }
  }
  const transitions = document.transitions
  if (!Array.isArray(transitions)) {
    issues.push({ path: 'transitions', message: 'transitions must be an array' })
  } else {
    for (const [index, transition] of transitions.entries()) {
      const record =
        transition !== null && typeof transition === 'object'
          ? (transition as Record<string, unknown>)
          : undefined
      if (
        !record ||
        typeof record.id !== 'string' ||
        typeof record.from !== 'string' ||
        typeof record.to !== 'string'
      ) {
        issues.push({
          path: `transitions[${index}]`,
          message: 'transition must declare string id, from, and to',
        })
      }
    }
  }
  return issues
}

/**
 * Builds a WorkItem from an inline Evaluate request body, defaulting the
 * fields a hypothetical item does not need. Returns an error string when
 * the body cannot identify an item.
 */
function normalizeInlineItem(raw: Readonly<Record<string, unknown>>): WorkItem | string {
  const externalId =
    typeof raw.externalId === 'string' && raw.externalId !== '' ? raw.externalId : undefined
  if (externalId === undefined) return 'item.externalId must be a non-empty string'
  const provider = typeof raw.provider === 'string' ? raw.provider : 'evaluate'
  const repository = raw.repository
  const hasRepository =
    repository !== null &&
    typeof repository === 'object' &&
    typeof (repository as Record<string, unknown>).locator === 'string'
  const metadata = raw.metadata
  return {
    id: asId<'work-item'>(`${provider}:${externalId}`),
    provider,
    externalId,
    title: typeof raw.title === 'string' ? raw.title : externalId,
    state: typeof raw.state === 'string' ? raw.state : '',
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((label): label is string => typeof label === 'string')
      : [],
    assignees: [],
    relationships: [],
    metadata:
      metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    ...(typeof raw.priority === 'string' ? { priority: raw.priority } : {}),
    ...(hasRepository ? { repository: repository as RepositoryReference } : {}),
  }
}
