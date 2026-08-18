/**
 * GraphScheduler: lane-based backlog consumption (mission §21), scheduled
 * and recurring workflows (§22), and routing dispatch with durable human
 * selection for ambiguous items (§28–§29).
 *
 * All time and identifier generation is injected; nothing here reads the
 * wall clock or randomness. Restart safety comes from persistence, not
 * memory: lane membership lives in the config repository, schedule firings
 * in the firing log (`lastFiring` guards double-fires), and selection
 * decisions plus approved routing rules in the config repository. Cron
 * evaluation is UTC, minute precision, with no external dependency.
 */

import type {
  Clock,
  EventBus,
  IdGenerator,
  LaneDefinition,
  Logger,
  OrchestratorEventPayload,
  PersistenceProvider,
  Run,
  RunId,
  ScheduleDefinition,
  WaitCondition,
  WorkItem,
} from '@overture/core'
import {
  asId,
  DefinitionKind,
  InputValidationFailure,
  isTerminal,
  OrchestratorError,
  validateHumanInputValue,
} from '@overture/core'
import {
  ROUTING_RULE_PROPOSAL,
  type RoutingDecision,
  type RoutingOutcome,
  type RoutingRule,
  type RoutingRuleSuggestion,
  routeItem,
  suggestRoutingRules,
  WORKFLOW_SELECTION_REQUIRED,
} from './routing.js'

/** Coordinator-shaped port: the scheduler never drives runs itself. */
export interface WorkflowStartPort {
  start(
    item: WorkItem,
    workflowName: string,
    runId: RunId,
    options?: {
      readonly variables?: Readonly<Record<string, unknown>>
      readonly workflowVersion?: number
    },
  ): Promise<Run>
}

/**
 * Blocking predicate over backlog items. The default treats an unresolved
 * `blocked-by` relationship as blocking; callers inject richer checks.
 */
export type BlockedPredicate = (item: WorkItem) => boolean | Promise<boolean>

export interface GraphSchedulerOptions {
  readonly persistence: PersistenceProvider
  readonly starter: WorkflowStartPort
  readonly events: EventBus
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly isBlocked?: BlockedPredicate
}

export interface LaneDispatchReport {
  readonly lane: string
  readonly started: readonly Run[]
  readonly skipped: ReadonlyArray<{ readonly item: WorkItem; readonly reason: string }>
  /** strict_serial only: the lane stopped because its top item is blocked. */
  readonly halted?: { readonly item: WorkItem; readonly reason: string }
}

export interface RoutingDispatch {
  readonly outcome: RoutingOutcome
  /** Present when a run was started (unique match with autoStart). */
  readonly runId?: string
  /** Present when a selection wait is open for the item. */
  readonly waitId?: string
}

const LANES_NAMESPACE = 'scheduler.lanes'
const ROUTING_NAMESPACE = 'routing'
const DECISIONS_KEY = 'decisions'
const RULE_KEY_PREFIX = 'rule:'

const defaultIsBlocked: BlockedPredicate = (item) =>
  item.relationships.some((relationship) => relationship.kind === 'blocked-by')

export class GraphScheduler {
  private readonly isBlocked: BlockedPredicate

  constructor(private readonly options: GraphSchedulerOptions) {
    this.isBlocked = options.isBlocked ?? defaultIsBlocked
  }

  // -----------------------------------------------------------------------
  // Lane dispatch (§21).
  // -----------------------------------------------------------------------

  /**
   * Consume backlog candidates for a lane. `candidates` must already be in
   * canonical backlog rank order; that order is never re-sorted here.
   * strict_serial and skip_blocked run at most one active run; the former
   * halts on a blocked top item, the latter skips it. ranked_parallel
   * fills up to `lane.maxActive` in rank order, skipping blocked items.
   */
  async dispatchLane(
    lane: LaneDefinition,
    candidates: readonly WorkItem[],
  ): Promise<LaneDispatchReport> {
    const started: Run[] = []
    const skipped: Array<{ item: WorkItem; reason: string }> = []
    if (!lane.enabled) return { lane: lane.name, started, skipped }

    const active = await this.activeLaneRunIds(lane.name)
    const capacity = lane.policy === 'ranked_parallel' ? Math.max(1, lane.maxActive) : 1
    let halted: { item: WorkItem; reason: string } | undefined

    for (const item of candidates) {
      // `active` carries prior lane runs and grows with each start below.
      if (active.length >= capacity) break

      let reason = (await this.isBlocked(item)) ? 'item is blocked' : undefined
      let workflow: string | undefined
      if (reason === undefined) {
        const resolved = await this.workflowForLaneItem(lane, item)
        if ('pending' in resolved) reason = resolved.pending
        else workflow = resolved.workflow
      }
      if (reason !== undefined) {
        if (lane.policy === 'strict_serial') {
          halted = { item, reason }
          this.publish(undefined, {
            type: 'work.updated',
            workItemId: String(item.id),
            detail: `lane ${lane.name} halted: ${reason}`,
          })
          break
        }
        skipped.push({ item, reason })
        this.publish(undefined, {
          type: 'work.updated',
          workItemId: String(item.id),
          detail: `lane ${lane.name} skipped: ${reason}`,
        })
        continue
      }

      const run = await this.claimAndStart(item, workflow as string)
      if (!run) {
        const claimReason = 'already claimed by an active run'
        if (lane.policy === 'strict_serial') {
          halted = { item, reason: claimReason }
          break
        }
        skipped.push({ item, reason: claimReason })
        continue
      }
      started.push(run)
      active.push(String(run.id))
    }

    await this.options.persistence.config.set(LANES_NAMESPACE, lane.name, active)
    return { lane: lane.name, started, skipped, ...(halted ? { halted } : {}) }
  }

  /** Lane runs still active, pruned of terminal ones (durable across restarts). */
  private async activeLaneRunIds(lane: string): Promise<string[]> {
    const persistence = this.options.persistence
    const tracked = (await persistence.config.get<readonly string[]>(LANES_NAMESPACE, lane)) ?? []
    const active: string[] = []
    for (const runId of tracked) {
      const run = await persistence.runs.get(asId<'run'>(runId))
      if (run && !isTerminal(run.state)) active.push(runId)
    }
    return active
  }

  /** A lane without a fixed workflow routes each item (§28). */
  private async workflowForLaneItem(
    lane: LaneDefinition,
    item: WorkItem,
  ): Promise<{ readonly workflow: string } | { readonly pending: string }> {
    if (lane.workflow !== undefined) return { workflow: lane.workflow }
    const outcome = routeItem(item, await this.listRules(), await this.enabledWorkflowNames())
    if (outcome.kind === 'unique') return { workflow: outcome.workflow }
    if (outcome.kind === 'ambiguous') {
      await this.openSelectionWait(item, outcome.workflows)
      return { pending: 'workflow selection required' }
    }
    return { pending: 'no matching routing rule' }
  }

  // -----------------------------------------------------------------------
  // Scheduled and recurring workflows (§22).
  // -----------------------------------------------------------------------

  /**
   * Fire schedules due at or before `now`. The last recorded firing's due
   * time is the restart-safe baseline: a schedule fires at most once per
   * due slot, and downtime collapses to a single catch-up firing at the
   * latest missed slot. First firings are measured from the schedule
   * definition's creation time.
   */
  async fireDueSchedules(now: Date): Promise<number> {
    const persistence = this.options.persistence
    const statuses = await persistence.definitions.list(DefinitionKind.Schedule)
    let fired = 0
    for (const status of statuses) {
      if (status.lifecycle !== 'enabled') continue
      const version = await persistence.definitions.get(DefinitionKind.Schedule, status.name)
      if (!version) continue
      const schedule = version.document as unknown as ScheduleDefinition
      if (!schedule.enabled) continue

      let spec: ScheduleSpec
      try {
        spec = parseScheduleSpec(schedule.cron)
      } catch (error) {
        this.options.logger.warn('unparseable schedule spec', {
          schedule: status.name,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      const last = await persistence.schedules.lastFiring(status.name)
      const due = latestDueAtOrBefore(spec, last?.dueAt ?? version.createdAt, now)
      if (!due) continue

      const runId = asId<'run'>(this.options.ids.next('run'))
      // Record before starting: a crash between the two loses one firing
      // rather than double-firing after restart.
      await persistence.schedules.recordFiring({
        scheduleName: status.name,
        dueAt: due,
        firedAt: now,
        runId: String(runId),
      })
      fired += 1

      const item = syntheticScheduleItem(schedule, due)
      this.publish(runId, {
        type: 'work.discovered',
        workItemId: String(item.id),
        provider: item.provider,
      })
      try {
        await this.options.starter.start(item, schedule.workflow, runId, {
          ...(schedule.payload ? { variables: schedule.payload } : {}),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.logger.error('scheduled workflow failed to start', {
          schedule: status.name,
          runId: String(runId),
          error: message,
        })
        this.publish(runId, { type: 'error', scope: 'schedule', message })
      }
    }
    return fired
  }

  // -----------------------------------------------------------------------
  // Routing dispatch and human selection (§28).
  // -----------------------------------------------------------------------

  /**
   * Route one item. A unique match starts only when its rule says
   * autoStart; ambiguity opens (or reuses) a durable single-choice wait
   * tagged WORKFLOW_SELECTION_REQUIRED; no match does nothing beyond an
   * event. Never guesses.
   */
  async route(
    item: WorkItem,
    options: {
      readonly rules?: readonly RoutingRule[]
      readonly enabledWorkflows?: readonly string[]
    } = {},
  ): Promise<RoutingDispatch> {
    const rules = options.rules ?? (await this.listRules())
    const enabledWorkflows = options.enabledWorkflows ?? (await this.enabledWorkflowNames())
    const outcome = routeItem(item, rules, enabledWorkflows)

    if (outcome.kind === 'no-match') {
      this.publish(undefined, {
        type: 'work.updated',
        workItemId: String(item.id),
        detail: 'routing: no matching rule',
      })
      return { outcome }
    }
    if (outcome.kind === 'ambiguous') {
      const waitId = await this.openSelectionWait(item, outcome.workflows)
      return { outcome, waitId }
    }
    if (outcome.rule.autoStart !== true) {
      this.publish(undefined, {
        type: 'work.updated',
        workItemId: String(item.id),
        detail: `routing: matched '${outcome.workflow}' (autoStart disabled)`,
      })
      return { outcome }
    }
    const run = await this.claimAndStart(item, outcome.workflow)
    return { outcome, ...(run ? { runId: String(run.id) } : {}) }
  }

  /**
   * Satisfy a workflow-selection wait. First valid response wins; later
   * ones become supplemental context. The selection is recorded for rule
   * learning before the chosen workflow starts.
   */
  async onSelection(
    waitId: string,
    selection: { readonly workflow: string; readonly responder: string },
  ): Promise<{ readonly accepted: boolean; readonly reason?: string; readonly runId?: string }> {
    const persistence = this.options.persistence
    const condition = await persistence.waits.get(waitId)
    if (!condition) return { accepted: false, reason: 'unknown wait' }
    if (condition.parameters.reason !== WORKFLOW_SELECTION_REQUIRED) {
      return { accepted: false, reason: 'not a workflow selection wait' }
    }
    if (condition.request) {
      try {
        validateHumanInputValue(condition.request, selection.workflow)
      } catch (error) {
        if (error instanceof InputValidationFailure) {
          return { accepted: false, reason: error.message }
        }
        throw error
      }
    }

    const now = this.options.clock.now()
    const input = {
      requestId: waitId,
      responder: selection.responder,
      channel: 'app' as const,
      at: now,
      value: selection.workflow,
    }
    const won = await persistence.waits.trySatisfy(waitId, {
      kind: condition.kind,
      at: now,
      input,
    })
    if (!won) {
      await persistence.waits.addSupplemental({ waitId, runId: condition.runId, input })
      return { accepted: false, reason: 'already satisfied; recorded as supplemental context' }
    }
    this.publish(condition.runId, {
      type: 'wait.satisfied',
      runId: condition.runId,
      waitId,
      waitKind: condition.kind,
    })
    this.publish(condition.runId, {
      type: 'human_input.received',
      runId: condition.runId,
      waitId,
      responder: selection.responder,
      channel: 'app',
    })

    const item = condition.parameters.item as WorkItem
    await this.recordDecision(item, selection.workflow, selection.responder, now)

    const run = await this.claimAndStart(item, selection.workflow)
    if (!run) {
      return { accepted: true, reason: 'selection recorded; item already claimed' }
    }
    return { accepted: true, runId: String(run.id) }
  }

  /** One open selection wait per item; re-routing reuses it. */
  private async openSelectionWait(item: WorkItem, workflows: readonly string[]): Promise<string> {
    const persistence = this.options.persistence
    const runId = asId<'run'>(`routing:${String(item.id)}`)
    const open = await persistence.waits.listOpen({ runId })
    const existing = open.find(
      (condition) => condition.parameters.reason === WORKFLOW_SELECTION_REQUIRED,
    )
    if (existing) return existing.id

    const condition: WaitCondition = {
      id: this.options.ids.next('wait'),
      runId,
      nodeId: 'routing',
      kind: 'human-input',
      parameters: {
        reason: WORKFLOW_SELECTION_REQUIRED,
        workItemId: String(item.id),
        candidates: [...workflows],
        item: item as unknown as Record<string, unknown>,
      },
      request: {
        type: 'single-choice',
        prompt: `Multiple workflows match '${item.title}'. Select the one to run.`,
        surface: 'app',
        choices: [...workflows],
      },
      status: 'open',
      createdAt: this.options.clock.now(),
    }
    await persistence.waits.save(condition)
    this.publish(runId, {
      type: 'routing.selection_required',
      workItemId: String(item.id),
      candidates: [...workflows],
    })
    this.publish(runId, {
      type: 'wait.opened',
      runId,
      waitId: condition.id,
      waitKind: condition.kind,
      nodeId: condition.nodeId,
    })
    this.publish(runId, {
      type: 'human_input.requested',
      runId,
      waitId: condition.id,
      inputType: 'single-choice',
      prompt: condition.request?.prompt ?? '',
      surface: 'app',
    })
    return condition.id
  }

  // -----------------------------------------------------------------------
  // Routing-rule learning (§29). Suggestions never self-apply.
  // -----------------------------------------------------------------------

  /** Suggestions from recorded selections, minus already-persisted rules. */
  async suggestRules(): Promise<readonly RoutingRuleSuggestion[]> {
    const history = await this.listDecisions()
    const existing = new Set((await this.listRules()).map((rule) => rule.condition))
    return suggestRoutingRules(history).filter((suggestion) => !existing.has(suggestion.condition))
  }

  /** Open an approval wait for a suggestion. Only approval persists it. */
  async proposeRule(suggestion: RoutingRuleSuggestion): Promise<string> {
    const persistence = this.options.persistence
    const runId = asId<'run'>(`routing-rule:${ruleNameFor(suggestion)}`)
    const open = await persistence.waits.listOpen({ runId })
    const existing = open.find((condition) => condition.parameters.reason === ROUTING_RULE_PROPOSAL)
    if (existing) return existing.id

    const prompt =
      `Apply routing rule: when ${suggestion.attribute.field} is ` +
      `'${suggestion.attribute.value}', route to '${suggestion.workflow}'? ` +
      `(evidence: ${suggestion.evidenceCount} selections)`
    const condition: WaitCondition = {
      id: this.options.ids.next('wait'),
      runId,
      nodeId: 'routing-rule',
      kind: 'approval',
      parameters: {
        reason: ROUTING_RULE_PROPOSAL,
        suggestion: suggestion as unknown as Record<string, unknown>,
      },
      request: { type: 'approval', prompt, surface: 'app' },
      status: 'open',
      createdAt: this.options.clock.now(),
    }
    await persistence.waits.save(condition)
    this.publish(runId, {
      type: 'approval.requested',
      runId,
      requestId: condition.id,
      description: prompt,
    })
    return condition.id
  }

  /** Resolve a rule proposal. The rule persists only on approval. */
  async onRuleApproval(
    waitId: string,
    response: { readonly approved: boolean; readonly responder: string },
  ): Promise<{ readonly accepted: boolean; readonly persisted: boolean }> {
    const persistence = this.options.persistence
    const condition = await persistence.waits.get(waitId)
    if (!condition || condition.parameters.reason !== ROUTING_RULE_PROPOSAL) {
      return { accepted: false, persisted: false }
    }
    const now = this.options.clock.now()
    const won = await persistence.waits.trySatisfy(waitId, {
      kind: condition.kind,
      at: now,
      input: {
        requestId: waitId,
        responder: response.responder,
        channel: 'app',
        at: now,
        value: response.approved,
      },
    })
    if (!won) return { accepted: false, persisted: false }

    this.publish(condition.runId, {
      type: 'approval.resolved',
      runId: condition.runId,
      requestId: waitId,
      approved: response.approved,
    })
    if (!response.approved) return { accepted: true, persisted: false }

    const suggestion = condition.parameters.suggestion as RoutingRuleSuggestion
    const rule: RoutingRule = {
      name: ruleNameFor(suggestion),
      condition: suggestion.condition,
      workflow: suggestion.workflow,
      autoStart: false,
    }
    await persistence.config.set(ROUTING_NAMESPACE, `${RULE_KEY_PREFIX}${rule.name}`, rule)
    return { accepted: true, persisted: true }
  }

  /** Persisted (human-approved) routing rules, stable by name. */
  async listRules(): Promise<readonly RoutingRule[]> {
    const entries = await this.options.persistence.config.list(ROUTING_NAMESPACE)
    return Object.entries(entries)
      .filter(([key]) => key.startsWith(RULE_KEY_PREFIX))
      .map(([, value]) => value as RoutingRule)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Recorded workflow selections (learning history). */
  async listDecisions(): Promise<readonly RoutingDecision[]> {
    const stored = await this.options.persistence.config.get<readonly RoutingDecision[]>(
      ROUTING_NAMESPACE,
      DECISIONS_KEY,
    )
    return stored ?? []
  }

  // -----------------------------------------------------------------------

  private async recordDecision(
    item: WorkItem,
    chosenWorkflow: string,
    responder: string,
    at: Date,
  ): Promise<void> {
    const decisions = [...(await this.listDecisions())]
    decisions.push({
      workItemId: String(item.id),
      characteristics: {
        labels: [...item.labels],
        ...(item.type !== undefined ? { type: item.type } : {}),
        ...(item.repository ? { repository: item.repository.locator } : {}),
      },
      chosenWorkflow,
      responder,
      at: at.toISOString(),
    })
    await this.options.persistence.config.set(ROUTING_NAMESPACE, DECISIONS_KEY, decisions)
  }

  private async claimAndStart(item: WorkItem, workflow: string): Promise<Run | undefined> {
    const persistence = this.options.persistence
    const runId = asId<'run'>(this.options.ids.next('run'))
    const claimed = await persistence.claims.tryClaim(item.id, runId)
    if (!claimed) {
      this.publish(undefined, {
        type: 'work.claim.rejected',
        workItemId: String(item.id),
        reason: 'already claimed by an active run',
      })
      return undefined
    }
    this.publish(runId, { type: 'work.claimed', workItemId: String(item.id), runId })
    return this.options.starter.start(item, workflow, runId)
  }

  private async enabledWorkflowNames(): Promise<readonly string[]> {
    const statuses = await this.options.persistence.definitions.list(DefinitionKind.Workflow)
    return statuses.filter((status) => status.lifecycle === 'enabled').map((s) => s.name)
  }

  private publish(runId: RunId | undefined, payload: OrchestratorEventPayload): void {
    this.options.events.publish({
      id: asId(this.options.ids.next('evt')),
      at: this.options.clock.now(),
      ...(runId ? { runId } : {}),
      ...payload,
    })
  }
}

function ruleNameFor(suggestion: RoutingRuleSuggestion): string {
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  return `${suggestion.attribute.field}-${slug(suggestion.attribute.value)}-${slug(suggestion.workflow)}`
}

function syntheticScheduleItem(schedule: ScheduleDefinition, due: Date): WorkItem {
  const externalId = `${schedule.name}@${due.toISOString()}`
  return {
    id: asId(`schedule:${externalId}`),
    provider: 'schedule',
    externalId,
    title: `Scheduled: ${schedule.name}`,
    state: 'scheduled',
    labels: ['scheduled'],
    assignees: [],
    relationships: [],
    metadata: {
      scheduleName: schedule.name,
      dueAt: due.toISOString(),
      ...(schedule.payload ? { payload: schedule.payload } : {}),
    },
    ...(schedule.description !== undefined ? { description: schedule.description } : {}),
  }
}

// ---------------------------------------------------------------------------
// Schedule specs: simple intervals and a 5-field cron subset, evaluated in
// UTC at minute precision. Pure functions; no wall clock.
// ---------------------------------------------------------------------------

type CronField = 'any' | readonly number[]

export type ScheduleSpec =
  | { readonly kind: 'interval'; readonly everyMs: number }
  | {
      readonly kind: 'cron'
      readonly minute: CronField
      readonly hour: CronField
      readonly dayOfMonth: CronField
      readonly month: CronField
      readonly dayOfWeek: CronField
    }

const INTERVAL_PATTERN = /^@?every\s+(\d+)(ms|s|m|h|d)$/i
const INTERVAL_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const MINUTE_MS = 60_000
/** Cron scan bound: a valid expression fires within 366 days. */
const MAX_SCAN_MINUTES = 366 * 24 * 60

/**
 * Parse a schedule spec: `every <n><unit>` (or `@every …`) as an interval,
 * anything else as 5-field cron (`* , - /` supported; numeric fields only,
 * day-of-week 0–7 with 7 = Sunday).
 */
export function parseScheduleSpec(source: string): ScheduleSpec {
  const trimmed = source.trim()
  const interval = INTERVAL_PATTERN.exec(trimmed)
  if (interval) {
    const everyMs =
      Number(interval[1]) * (INTERVAL_UNIT_MS[(interval[2] as string).toLowerCase()] as number)
    if (everyMs <= 0)
      throw new OrchestratorError(`interval must be positive: '${source}'`, 'invalid-input')
    return { kind: 'interval', everyMs }
  }
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new OrchestratorError(
      `expected 5 cron fields or an interval, got '${source}'`,
      'invalid-input',
    )
  }
  return {
    kind: 'cron',
    minute: parseCronField(fields[0] as string, 0, 59),
    hour: parseCronField(fields[1] as string, 0, 23),
    dayOfMonth: parseCronField(fields[2] as string, 1, 31),
    month: parseCronField(fields[3] as string, 1, 12),
    dayOfWeek: parseCronField(fields[4] as string, 0, 7, (value) => (value === 7 ? 0 : value)),
  }
}

function parseCronField(
  source: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): CronField {
  if (source === '*') return 'any'
  const values = new Set<number>()
  for (const part of source.split(',')) {
    const stepped = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!stepped) throw new OrchestratorError(`bad cron field '${source}'`, 'invalid-input')
    const [, base, stepRaw] = stepped
    const step = stepRaw !== undefined ? Number(stepRaw) : 1
    if (step < 1) throw new OrchestratorError(`bad cron step in '${source}'`, 'invalid-input')
    let low: number
    let high: number
    if (base === '*') {
      low = min
      high = max
    } else {
      const range = (base as string).split('-').map(Number)
      low = range[0] as number
      high = range.length > 1 ? (range[1] as number) : stepRaw !== undefined ? max : low
    }
    if (low < min || high > max || low > high) {
      throw new OrchestratorError(
        `cron field '${source}' out of range ${min}-${max}`,
        'invalid-input',
      )
    }
    for (let value = low; value <= high; value += step) values.add(normalize(value))
  }
  return [...values].sort((a, b) => a - b)
}

function fieldMatches(field: CronField, value: number): boolean {
  return field === 'any' || field.includes(value)
}

function cronMatches(spec: Extract<ScheduleSpec, { kind: 'cron' }>, date: Date): boolean {
  if (!fieldMatches(spec.minute, date.getUTCMinutes())) return false
  if (!fieldMatches(spec.hour, date.getUTCHours())) return false
  if (!fieldMatches(spec.month, date.getUTCMonth() + 1)) return false
  const domMatch = fieldMatches(spec.dayOfMonth, date.getUTCDate())
  const dowMatch = fieldMatches(spec.dayOfWeek, date.getUTCDay())
  // Standard cron: when both day fields are restricted, either may match.
  if (spec.dayOfMonth !== 'any' && spec.dayOfWeek !== 'any') return domMatch || dowMatch
  return domMatch && dowMatch
}

/** The first firing time strictly after `after`. */
export function nextFireTime(spec: ScheduleSpec, after: Date): Date {
  if (spec.kind === 'interval') return new Date(after.getTime() + spec.everyMs)
  let candidate = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  for (let scanned = 0; scanned < MAX_SCAN_MINUTES; scanned += 1) {
    if (cronMatches(spec, candidate)) return candidate
    candidate = new Date(candidate.getTime() + MINUTE_MS)
  }
  throw new OrchestratorError('cron expression never fires within 366 days', 'invalid-input')
}

/**
 * The latest due slot in (base, now], or undefined when nothing is due.
 * Collapsing to the latest slot means downtime yields one catch-up firing
 * instead of a replay storm.
 */
function latestDueAtOrBefore(spec: ScheduleSpec, base: Date, now: Date): Date | undefined {
  if (spec.kind === 'interval') {
    const elapsed = now.getTime() - base.getTime()
    if (elapsed < spec.everyMs) return undefined
    return new Date(base.getTime() + Math.floor(elapsed / spec.everyMs) * spec.everyMs)
  }
  // Bound the scan for very old baselines (long downtime).
  const floor = new Date(now.getTime() - MAX_SCAN_MINUTES * MINUTE_MS)
  let cursor = base < floor ? floor : base
  let due: Date | undefined
  for (;;) {
    const next = nextFireTime(spec, cursor)
    if (next.getTime() > now.getTime()) return due
    due = next
    cursor = next
  }
}
