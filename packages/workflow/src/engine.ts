/**
 * Executes a validated `WorkflowDefinition`. The engine never performs work
 * itself — every step kind (agent/command/action/approval) is delegated to
 * an executor supplied by the caller via `WorkflowExecutionContext.executors`.
 *
 * Scheduling
 * ----------
 * Steps run once every dependency has *settled* (succeeded/failed/skipped).
 * All steps whose dependencies are settled run concurrently, bounded by
 * `context.concurrency` (default: unlimited).
 *
 * Eligibility (decided once a step's dependencies have all settled)
 * -------------------------------------------------------------------
 *  - If the step declares `when`, that expression is the *entire* rule:
 *    true -> run, false -> skip. This is what lets a remediation step run
 *    specifically because a dependency failed, e.g. `when: steps.review.failed`.
 *  - Otherwise (no `when`), the step runs only if every dependency's result
 *    is 'succeeded', OR 'failed' with that dependency's own `continueOnFailure`
 *    set — i.e. continueOnFailure lets a failed step's dependents proceed as
 *    if it had succeeded. Any other outcome (plain failure, or skip) causes
 *    this step to be skipped, and that skip then propagates the same way to
 *    steps depending on it.
 *
 * Overall status
 * --------------
 * A step that nobody depends on is a "terminal" step. Whether the workflow
 * succeeds depends on how each terminal step ended, and — for skips — *why*:
 *
 *  - A step that fails without `continueOnFailure` is TAINTED.
 *  - A default-rule (no `when`) skip caused by a tainted or (non-forgiven)
 *    failed dependency is itself TAINTED, and that taint keeps propagating
 *    downstream through further no-`when` skips exactly the way eligibility
 *    itself propagates (see above).
 *  - A skip caused purely by `when` evaluating false is always BENIGN, full
 *    stop — regardless of what the expression referenced. `when` is how a
 *    workflow author declares "this step is optional here," so its skip
 *    can never fail the workflow on its own; only a step that actually ran
 *    and failed (or a tainted default-rule skip) can.
 *
 * The workflow succeeds iff every terminal step ended 'succeeded', or ended
 * 'skipped' *without* being tainted, or ended 'failed' with its own
 * `continueOnFailure` set. Any terminal step that is 'failed' (without
 * continueOnFailure) or a tainted 'skipped' fails the whole workflow.
 *
 * Consequence for workflow authors: if a delivery step's eligibility is
 * gated entirely behind `when` (e.g. `when: steps.review.succeeded ||
 * steps.remediate.succeeded`), that gate's own skip is always benign — so a
 * genuine "nothing worked" outcome must actually be decided (and reported
 * as a real failure) by a step that runs unconditionally, not inferred from
 * an unreached `when`-gated step. See the built-in `software-development`
 * workflow's `approve_delivery` step for the pattern.
 *
 * Cancellation
 * ------------
 * When `context.signal` aborts, no further steps are launched; already
 * in-flight steps are signalled to abort (cooperatively — the engine cannot
 * forcibly terminate an executor that ignores its signal) and awaited before
 * returning. Any step that never started is recorded as 'skipped'
 * (reason: workflow cancelled). The overall result status is 'cancelled'.
 *
 * Interpolation
 * -------------
 * Before an executor is invoked, `${{ ... }}` placeholders in the step's own
 * template-ish string fields (agent `goal`, command `command`/`cwd`/`env`
 * values, action `with` string values, approval `description`) are resolved
 * against the current variables and settled step results — so, e.g., a
 * command step can read `${{ vars.test_command }}` or an action step's
 * `with.title` can read `${{ steps.analyze.outputs.title }}`. `when` is
 * exempt: it's evaluated as an expression directly, never interpolated.
 */

import type {
  Clock,
  RetryPolicy,
  StepKind,
  StepResult,
  WorkflowDefinition,
  WorkflowStep,
} from '@overture/core'
import { systemClock } from '@overture/core'
import {
  type ExpressionContext,
  evaluateExpression,
  interpolate,
  parseExpression,
} from './expressions.js'

export interface StepExecutorSuccess {
  readonly status: 'succeeded'
  readonly outputs?: Readonly<Record<string, unknown>>
}

export interface StepExecutorFailure {
  readonly status: 'failed'
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly error?: string
}

export type StepExecutorResult = StepExecutorSuccess | StepExecutorFailure

export interface StepExecutionState {
  readonly variables: Readonly<Record<string, unknown>>
  readonly stepResults: ReadonlyMap<string, StepResult>
  readonly signal: AbortSignal
  readonly attempt: number
}

/** Runs a single step. Throwing is equivalent to returning `{ status: 'failed', error: <message> }`. */
export type StepExecutorFn = (
  step: WorkflowStep,
  state: StepExecutionState,
) => Promise<StepExecutorResult>

export type WorkflowEngineEvent =
  | { readonly type: 'step.started'; readonly stepId: string }
  | {
      readonly type: 'step.completed'
      readonly stepId: string
      readonly status: StepResult['status']
    }
  | { readonly type: 'step.skipped'; readonly stepId: string; readonly reason: string }

export interface WorkflowExecutionContext {
  readonly executors: Readonly<Record<StepKind, StepExecutorFn>>
  readonly variables?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEngineEvent) => void
  readonly clock?: Clock
  /** Maximum number of steps to run concurrently. Default: unlimited. */
  readonly concurrency?: number
}

export type WorkflowRunStatus = 'succeeded' | 'failed' | 'cancelled'
export type WorkflowTransitionKind = 'success' | 'failure' | 'blocked'

export interface WorkflowResult {
  readonly status: WorkflowRunStatus
  readonly stepResults: ReadonlyMap<string, StepResult>
  readonly transition: WorkflowTransitionKind
  /** The state to move the work item to, per `definition.transitions`, if configured. */
  readonly transitionTarget?: string
}

/** Rejects once `timeoutSignal` fires. Raced against the executor's promise so a step that never settles still times out. */
function waitForTimeout(
  timeoutSignal: AbortSignal,
  stepId: string,
  timeoutMs: number,
): Promise<never> {
  return new Promise((_, reject) => {
    if (timeoutSignal.aborted) {
      reject(new Error(`step '${stepId}' timed out after ${timeoutMs}ms`))
      return
    }
    timeoutSignal.addEventListener(
      'abort',
      () => reject(new Error(`step '${stepId}' timed out after ${timeoutMs}ms`)),
      { once: true },
    )
  })
}

/** Resolves `${{ ... }}` placeholders in a step's own template-ish string fields. See the class doc comment. */
function interpolateStep(step: WorkflowStep, ctx: ExpressionContext): WorkflowStep {
  switch (step.kind) {
    case 'agent':
      return { ...step, goal: interpolate(step.goal, ctx) }
    case 'command':
      return {
        ...step,
        command: interpolate(step.command, ctx),
        ...(step.cwd !== undefined ? { cwd: interpolate(step.cwd, ctx) } : {}),
        ...(step.env !== undefined ? { env: interpolateStringRecord(step.env, ctx) } : {}),
      }
    case 'action':
      return {
        ...step,
        ...(step.with !== undefined ? { with: interpolateValues(step.with, ctx) } : {}),
      }
    case 'approval':
      return { ...step, description: interpolate(step.description, ctx) }
  }
}

function interpolateStringRecord(
  record: Readonly<Record<string, string>>,
  ctx: ExpressionContext,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolate(value, ctx)]),
  )
}

/** Interpolates string values in a `with` bag; non-string values pass through untouched. */
function interpolateValues(
  record: Readonly<Record<string, unknown>>,
  ctx: ExpressionContext,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === 'string' ? interpolate(value, ctx) : value,
    ]),
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export class WorkflowEngine {
  async execute(
    definition: WorkflowDefinition,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowResult> {
    const variables: Record<string, unknown> = {
      ...(definition.variables ?? {}),
      ...(context.variables ?? {}),
    }
    const clock = context.clock ?? systemClock
    const parentSignal = context.signal ?? new AbortController().signal
    const concurrencyLimit =
      context.concurrency !== undefined && context.concurrency > 0
        ? context.concurrency
        : Number.POSITIVE_INFINITY

    const byId = new Map(definition.steps.map((step) => [step.id, step] as const))
    const results = new Map<string, StepResult>()
    const evalCtx: ExpressionContext = { steps: results, vars: variables }

    const inFlight = new Map<string, Promise<void>>()
    const pendingIds = new Set(definition.steps.map((step) => step.id))

    const abortWaiter: Promise<void> | null = context.signal
      ? new Promise((resolve) => {
          if (context.signal?.aborted) {
            resolve()
            return
          }
          context.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      : null

    let cancelled = parentSignal.aborted

    // Step ids whose outcome reflects a real failure: either the step itself failed
    // without continueOnFailure, or it was skipped because of a tainted/failed
    // dependency under the default (no `when`) rule. A `when`-false skip is never
    // added here — see the class doc comment.
    const tainted = new Set<string>()

    const depsSettled = (step: WorkflowStep) =>
      (step.dependsOn ?? []).every((dep) => results.has(dep))

    const isEligible = (
      step: WorkflowStep,
    ): { eligible: boolean; reason?: string; tainted?: boolean } => {
      if (step.when !== undefined) {
        const value = Boolean(evaluateExpression(parseExpression(step.when), evalCtx))
        return value
          ? { eligible: true }
          : { eligible: false, reason: `when condition '${step.when}' evaluated to false` }
      }
      let allOk = true
      let causesTaint = false
      let firstBadDep: string | undefined
      let firstBadStatus: StepResult['status'] | undefined
      for (const depId of step.dependsOn ?? []) {
        const depResult = results.get(depId) as StepResult
        const depStep = byId.get(depId)
        const forgiven = depResult.status === 'failed' && depStep?.continueOnFailure === true
        const ok = depResult.status === 'succeeded' || forgiven
        if (!ok) {
          allOk = false
          if (firstBadDep === undefined) {
            firstBadDep = depId
            firstBadStatus = depResult.status
          }
          if ((depResult.status === 'failed' && !forgiven) || tainted.has(depId)) {
            causesTaint = true
          }
        }
      }
      if (!allOk) {
        return {
          eligible: false,
          reason: `dependency '${firstBadDep}' did not succeed (status: ${firstBadStatus})`,
          tainted: causesTaint,
        }
      }
      return { eligible: true }
    }

    while (pendingIds.size > 0 && !cancelled) {
      const ready = [...pendingIds].filter((id) => depsSettled(byId.get(id) as WorkflowStep))
      const capacity = Math.max(0, concurrencyLimit - inFlight.size)
      const toLaunch = ready.slice(0, capacity)

      if (toLaunch.length === 0 && inFlight.size === 0) {
        // No progress possible: only reachable from a malformed (non-DAG) definition
        // bypassing parser validation. Fail the remaining steps rather than hang.
        for (const id of pendingIds) {
          results.set(id, {
            stepId: id,
            status: 'skipped',
            outputs: {},
            error: 'unresolved dependency graph',
          })
          tainted.add(id)
        }
        pendingIds.clear()
        break
      }

      for (const id of toLaunch) {
        pendingIds.delete(id)
        const step = byId.get(id) as WorkflowStep
        const { eligible, reason, tainted: isTainted } = isEligible(step)
        if (!eligible) {
          results.set(id, { stepId: id, status: 'skipped', outputs: {}, error: reason as string })
          if (isTainted) tainted.add(id)
          context.onEvent?.({ type: 'step.skipped', stepId: id, reason: reason as string })
          continue
        }
        context.onEvent?.({ type: 'step.started', stepId: id })
        const task = this.runStep(step, context, evalCtx, parentSignal, clock).then((result) => {
          results.set(id, result)
          if (result.status === 'failed' && !step.continueOnFailure) tainted.add(id)
          context.onEvent?.({ type: 'step.completed', stepId: id, status: result.status })
        })
        inFlight.set(id, task)
        task.finally(() => inFlight.delete(id))
      }

      if (inFlight.size === 0) {
        // Everything launched this pass was skipped synchronously (no async task was
        // started). Loop again immediately to pick up newly-ready steps instead of
        // waiting on nothing — there may be nothing in `inFlight` yet plenty left in
        // `pendingIds`.
        continue
      }

      const waiters: Promise<unknown>[] = [...inFlight.values()]
      if (abortWaiter) waiters.push(abortWaiter)
      await Promise.race(waiters)
      if (context.signal?.aborted) cancelled = true
    }

    if (cancelled) {
      await Promise.allSettled([...inFlight.values()])
      for (const id of pendingIds) {
        if (!results.has(id)) {
          results.set(id, {
            stepId: id,
            status: 'skipped',
            outputs: {},
            error: 'workflow cancelled',
          })
        }
      }
    }

    const status: WorkflowRunStatus = cancelled
      ? 'cancelled'
      : this.computeStatus(definition, results, tainted)
    const transition: WorkflowTransitionKind =
      status === 'succeeded' ? 'success' : status === 'cancelled' ? 'blocked' : 'failure'
    const transitionTarget = definition.transitions?.[transition]

    return {
      status,
      stepResults: results,
      transition,
      ...(transitionTarget !== undefined ? { transitionTarget } : {}),
    }
  }

  private async runStep(
    step: WorkflowStep,
    context: WorkflowExecutionContext,
    evalCtx: ExpressionContext,
    parentSignal: AbortSignal,
    clock: Clock,
  ): Promise<StepResult> {
    const startedAt = clock.now()
    const retry: RetryPolicy | undefined = step.retry
    const maxAttempts = retry?.maxAttempts ?? 1
    const backoffMs = retry?.backoffMs ?? 0
    const executor = context.executors[step.kind]

    let lastError: string | undefined
    let lastOutputs: Readonly<Record<string, unknown>> = {}

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Resolve ${{ ... }} placeholders against the latest variables/step results on
      // every attempt (cheap, and correct if concurrent steps settled between retries).
      const interpolatedStep = interpolateStep(step, evalCtx)
      // The timeout signal is kept separate from the combined signal passed to the
      // executor so a cooperative executor can observe both parent cancellation and
      // its own timeout, while the engine can still race a *non*-cooperative executor
      // (one that never settles) against the timeout and move on regardless.
      const timeoutSignal =
        step.timeoutMs !== undefined ? AbortSignal.timeout(step.timeoutMs) : undefined
      const stepSignal = timeoutSignal
        ? AbortSignal.any([parentSignal, timeoutSignal])
        : parentSignal
      try {
        const executorPromise = executor(interpolatedStep, {
          variables: evalCtx.vars,
          stepResults: evalCtx.steps,
          signal: stepSignal,
          attempt,
        })
        const outcome = timeoutSignal
          ? await Promise.race([
              executorPromise,
              waitForTimeout(timeoutSignal, step.id, step.timeoutMs as number),
            ])
          : await executorPromise
        if (outcome.status === 'succeeded') {
          return {
            stepId: step.id,
            status: 'succeeded',
            outputs: outcome.outputs ?? {},
            startedAt,
            finishedAt: clock.now(),
          }
        }
        lastError = outcome.error
        lastOutputs = outcome.outputs ?? {}
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }

      if (parentSignal.aborted) break
      if (attempt < maxAttempts) {
        await sleep(backoffMs, parentSignal)
        if (parentSignal.aborted) break
      }
    }

    return {
      stepId: step.id,
      status: 'failed',
      outputs: lastOutputs,
      startedAt,
      finishedAt: clock.now(),
      ...(lastError !== undefined ? { error: lastError } : {}),
    }
  }

  private computeStatus(
    definition: WorkflowDefinition,
    results: ReadonlyMap<string, StepResult>,
    tainted: ReadonlySet<string>,
  ): 'succeeded' | 'failed' {
    const dependedOn = new Set<string>()
    for (const step of definition.steps) {
      for (const dep of step.dependsOn ?? []) dependedOn.add(dep)
    }
    const terminalSteps = definition.steps.filter((step) => !dependedOn.has(step.id))

    for (const step of terminalSteps) {
      const result = results.get(step.id)
      if (!result) return 'failed'
      const failedHard = result.status === 'failed' && !step.continueOnFailure
      const taintedSkip = result.status === 'skipped' && tainted.has(step.id)
      if (failedHard || taintedSkip) return 'failed'
    }
    return 'succeeded'
  }
}
