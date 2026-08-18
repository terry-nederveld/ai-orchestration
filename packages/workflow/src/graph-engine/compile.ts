/**
 * Compiles a v1 step-DAG `WorkflowDefinition` (ADR-0008) into the durable
 * workflow graph model (ADR-0017), preserving v1 execution semantics:
 *
 * - Each v1 step becomes one graph node (agent/command/action steps map
 *   directly; approval steps become 'human-input' nodes with an
 *   approval-type request). Goals, commands, `with` bags, env, cwd,
 *   timeouts, and retry policies are carried onto the node.
 * - `depends_on` becomes success-conditioned transitions into an all-join
 *   (a dependency with `continueOnFailure` contributes an unconditional
 *   edge instead — it fires on any settle, matching v1's pass-through).
 * - A v1 `when` step compiles to a synthetic decision node
 *   (`__when_<step>`) that joins one firing per dependency — fired on
 *   settle regardless of status, because v1 evaluates `when` once deps
 *   settle, success or not — and then routes to the step (when true) or
 *   to its benign-skip channel (when false).
 * - Benign-skip propagation: v1 says a step depending on a `when`-false
 *   skipped step is itself benignly skipped, transitively, and a benign
 *   skip at a terminal step still counts as overall success. Every step
 *   that can benignly skip ("skip-capable": it has a `when`, or any
 *   dependency is skip-capable) gets a `__skip_<step>` channel node; a
 *   dependency contributes exactly one potential firing to each dependent
 *   — its settle-edge OR its skip-edge, never both — so joins stay exact.
 *   Decision nodes therefore use a min-join with n = dependency count.
 * - Overall status: a synthetic `__success` terminal all-joins one
 *   `__done_<step>` relay per v1 terminal step (a step nothing depends
 *   on). `__done_<step>` any-joins the step's success edge (unconditional
 *   when the step has `continueOnFailure`, matching v1's forgiveness at
 *   terminals) and its benign-skip channel. The v1 tainted-skip rule
 *   needs no explicit channel: a hard failure either fires no transition
 *   (the engine fails the run at the settlement) or starves the
 *   `__success` all-join (the engine fails the run as a stall) — both
 *   reproduce v1's "workflow fails iff a terminal step failed or was
 *   skipped-and-tainted".
 *
 * `${{ … }}` interpolation inside goals/commands/`with`/env/cwd/approval
 * descriptions is carried through as literal text: the compiler does not
 * translate it. NOTE: the graph node executors do NOT currently resolve
 * `${{ … }}` either — a compiled v1 workflow that relied on interpolation
 * runs with the placeholder unresolved. This is a known functional gap,
 * NOT a green light to add interpolation into the command/gate path: v1's
 * shell-command interpolation goes through env-var indirection
 * (`interpolateForShell`, ADR-0016) precisely so attacker-controlled work
 * item text never lands in a shell argument. Any future interpolation on
 * the graph command/gate path MUST reuse that indirection, never a naive
 * string splice.
 *
 * v1 `transitions.success`/`failure`/`blocked` targets are NOT compiled:
 * they are projections of the run outcome onto the external work item,
 * which the orchestrator applies outside the graph (ADR-0017 layer 4).
 * Likewise `workspace` and `budget` are run-provisioning concerns with no
 * graph representation.
 *
 * Known divergence (inherent to the taint-as-stall encoding): a `when`
 * step downstream of a TAINTED skip that v1 would have "recovered" (the
 * tainted step feeds a when-step whose condition still passes, and every
 * v1 terminal ends fine) fails in the compiled graph — the tainted step
 * fires no edges, so the when-node never evaluates and the run stalls to
 * failure. No built-in workflow exercises this; a user workflow that
 * needs it should model the recovery as an explicit failure edge instead.
 */

import type {
  GraphNode,
  GraphNodeConfig,
  GraphTransition,
  JoinSpec,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowStep,
} from '@overture/core'
import { type Expression, parseExpression } from '../expressions.js'

/** Fires only when the settling source node succeeded. */
const SUCCEEDED = "node.status == 'succeeded'"

const startNodeId = '__start'
const successNodeId = '__success'
const whenNodeId = (stepId: string) => `__when_${stepId}`
const skipNodeId = (stepId: string) => `__skip_${stepId}`
const doneNodeId = (stepId: string) => `__done_${stepId}`

/**
 * Re-emits a v1 `when`/`condition` expression in graph scope syntax
 * (`steps.x.*` → `results.x.*`; `vars.*` and operators map 1:1). Walks
 * the v1 parser's AST — never the source text.
 */
export function translateV1Expression(source: string): string {
  return emitExpression(parseExpression(source))
}

function emitExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'string' ? `'${expr.value}'` : String(expr.value)
    case 'var':
      return `vars.${expr.name}`
    case 'stepField':
      // Graph nodes never settle as 'skipped' — a bypassed step simply has
      // no result — so v1 `steps.x.skipped` becomes "neither succeeded nor
      // failed", which is exactly what a bypassed (or v1-skipped) step
      // looks like once its dependents are evaluated.
      if (expr.field === 'skipped') {
        return `(!results.${expr.stepId}.succeeded && !results.${expr.stepId}.failed)`
      }
      return `results.${expr.stepId}.${expr.field}`
    case 'stepOutput':
      return `results.${expr.stepId}.outputs.${expr.key}`
    case 'unary':
      return `!${emitExpression(expr.operand)}`
    case 'binary':
      return `(${emitExpression(expr.left)} ${expr.op} ${emitExpression(expr.right)})`
  }
}

function toNodeConfig(step: WorkflowStep): GraphNodeConfig {
  switch (step.kind) {
    case 'agent':
      return {
        kind: 'agent',
        goal: step.goal,
        profile: { name: step.route ?? step.agent },
        ...(step.toolNames !== undefined ? { toolNames: step.toolNames } : {}),
        ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      }
    case 'command':
      return {
        kind: 'command',
        command: step.command,
        ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
        ...(step.env !== undefined ? { env: step.env } : {}),
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      }
    case 'action':
      // ActionNodeConfig has no timeout slot; a v1 action timeout is a
      // per-executor concern the graph model does not carry.
      return {
        kind: 'action',
        action: step.action,
        ...(step.with !== undefined ? { with: step.with } : {}),
      }
    case 'approval':
      return {
        kind: 'human-input',
        request: {
          type: 'approval',
          prompt: step.description,
          surface: 'both',
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        },
      }
  }
}

/** Compiles a validated v1 `WorkflowDefinition` into an ADR-0017 graph. */
export function compileWorkflow(definition: WorkflowDefinition): WorkflowGraph {
  if (definition.steps.length === 0) {
    throw new Error(`cannot compile workflow '${definition.name}': it has no steps`)
  }
  for (const step of definition.steps) {
    if (step.id.startsWith('__')) {
      throw new Error(
        `cannot compile workflow '${definition.name}': step id '${step.id}' collides with the compiler's synthetic '__' namespace`,
      )
    }
  }

  const stepsById = new Map(definition.steps.map((step) => [step.id, step] as const))
  const dependedOn = new Set<string>()
  for (const step of definition.steps) {
    for (const dep of step.dependsOn ?? []) dependedOn.add(dep)
  }

  // A step is skip-capable when it can end benignly skipped: it has a
  // `when`, or a dependency's benign skip can cascade into it. The parser
  // guarantees the dependency graph is acyclic, so memoized recursion
  // terminates.
  const skipCapableMemo = new Map<string, boolean>()
  const isSkipCapable = (stepId: string): boolean => {
    const memo = skipCapableMemo.get(stepId)
    if (memo !== undefined) return memo
    const step = stepsById.get(stepId)
    const capable =
      step !== undefined &&
      (step.when !== undefined || (step.dependsOn ?? []).some((dep) => isSkipCapable(dep)))
    skipCapableMemo.set(stepId, capable)
    return capable
  }

  const nodes: GraphNode[] = []
  const transitions: GraphTransition[] = []
  let transitionCount = 0
  const addTransition = (from: string, to: string, condition?: string) => {
    transitions.push({
      id: `t${transitionCount++}:${from}->${to}`,
      from,
      to,
      ...(condition !== undefined ? { condition } : {}),
    })
  }
  const noop = (id: string, join?: JoinSpec): GraphNode => ({
    id,
    config: { kind: 'action', action: 'workflow.noop' },
    ...(join !== undefined ? { join } : {}),
  })

  nodes.push(noop(startNodeId))

  for (const step of definition.steps) {
    const deps = step.dependsOn ?? []

    nodes.push({
      id: step.id,
      config: toNodeConfig(step),
      // Multi-input no-when steps all-join their dependencies' edges. A
      // when-step's only input is its decision node's true-edge.
      ...(step.when === undefined && deps.length >= 2 ? { join: { mode: 'all' } } : {}),
      ...(step.retry !== undefined ? { retry: step.retry } : {}),
    })

    if (step.when !== undefined) {
      // v1: `when` is the entire eligibility rule, evaluated once every
      // dependency has settled — success or failure alike — so every
      // dependency edge into the decision node is unconditional. A
      // skip-capable dependency contributes its firing through either its
      // settle-edge or its skip-edge (mutually exclusive), which is why
      // the join counts n = deps.length rather than 'all' inbound edges.
      const translated = translateV1Expression(step.when)
      const hasSkipCapableDep = deps.some((dep) => isSkipCapable(dep))
      const join: JoinSpec | undefined =
        deps.length === 0
          ? undefined
          : hasSkipCapableDep
            ? { mode: 'min', n: deps.length }
            : { mode: 'all' }
      nodes.push(noop(whenNodeId(step.id), join))
      nodes.push(noop(skipNodeId(step.id)))
      if (deps.length === 0) addTransition(startNodeId, whenNodeId(step.id))
      for (const dep of deps) {
        addTransition(dep, whenNodeId(step.id))
        if (isSkipCapable(dep)) addTransition(skipNodeId(dep), whenNodeId(step.id))
      }
      addTransition(whenNodeId(step.id), step.id, translated)
      addTransition(whenNodeId(step.id), skipNodeId(step.id), `!(${translated})`)
    } else {
      if (deps.length === 0) addTransition(startNodeId, step.id)
      for (const dep of deps) {
        // continueOnFailure on the DEPENDENCY forgives its failure for
        // dependents: the edge fires on any settle, as in v1.
        const depStep = stepsById.get(dep)
        addTransition(dep, step.id, depStep?.continueOnFailure ? undefined : SUCCEEDED)
      }
      if (isSkipCapable(step.id)) {
        // No `when` of its own, so this step benignly skips exactly when a
        // skip-capable dependency benignly skipped: propagate the skip
        // channel (any-join — one bypassed dependency suffices, matching
        // v1's "any dependency not succeeded" skip rule; taint-causing
        // failures leave every skip channel unfired and starve the run).
        nodes.push(noop(skipNodeId(step.id)))
        for (const dep of deps) {
          if (isSkipCapable(dep)) addTransition(skipNodeId(dep), skipNodeId(step.id))
        }
      }
    }
  }

  // Overall-status wiring: one __done relay per v1 terminal step, all-joined
  // by the __success terminal. A hard-failed or taint-skipped terminal step
  // never fires its __done edge, so __success starves and the engine fails
  // the run — v1's tainted-skip rule, structurally.
  const terminalSteps = definition.steps.filter((step) => !dependedOn.has(step.id))
  for (const step of terminalSteps) {
    nodes.push(noop(doneNodeId(step.id)))
    addTransition(step.id, doneNodeId(step.id), step.continueOnFailure ? undefined : SUCCEEDED)
    if (isSkipCapable(step.id)) addTransition(skipNodeId(step.id), doneNodeId(step.id))
    addTransition(doneNodeId(step.id), successNodeId)
  }
  nodes.push({
    id: successNodeId,
    config: { kind: 'terminal', outcome: 'completed' },
    join: { mode: 'all' },
  })

  return {
    name: definition.name,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    entry: startNodeId,
    nodes,
    transitions,
    ...(definition.trigger !== undefined ? { trigger: definition.trigger } : {}),
    ...(definition.eligibility !== undefined ? { eligibility: definition.eligibility } : {}),
    ...(definition.variables !== undefined ? { variables: definition.variables } : {}),
  }
}
