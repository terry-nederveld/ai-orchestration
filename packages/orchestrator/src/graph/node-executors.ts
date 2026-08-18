/**
 * Graph node executors: bind node kinds to the run's world. The engine
 * stays pure; everything here is injected — agent executors resolve
 * through profiles pinned in the snapshot, gates evaluate and remediate
 * with independent re-evaluation, waits and human input yield durable
 * suspensions, and sub-workflows/fan-outs delegate to a child-run port.
 */

import type {
  AgentProfileDefinition,
  AgentRunRequest,
  Clock,
  DefinitionVersion,
  EvaluationRubric,
  EventBus,
  ExperimentDefinition,
  Gate,
  GateEvaluation,
  GateSet,
  IdGenerator,
  JoinSpec,
  Logger,
  ProfileFragment,
  ResolvedProfile,
  ResolvedSnapshot,
  Run,
  WaitSatisfaction,
  WorkflowGraph,
  WorkItem,
  Workspace,
} from '@overture/core'
import {
  composeGateSets,
  composeProfile,
  DefinitionKind,
  findInSnapshot,
  OrchestratorError,
} from '@overture/core'
import {
  evaluateScopeExpression,
  evaluateScopeValue,
  type GraphNodeExecutor,
  type GraphNodeExecutors,
  type NodeExecutionContext,
  type NodeYield,
} from '@overture/workflow'
import type { CommandRunner, ResolvedAgentExecutor } from '../ports.js'

/** Resolves executor ids ('native-anthropic', 'claude-code', …). */
export interface ExecutorResolver {
  get(executorId: string): ResolvedAgentExecutor['start'] | undefined
}

/** Started by fan-out/subworkflow nodes; satisfied when children settle. */
export interface ChildRunner {
  start(options: {
    readonly parentRunId: string
    readonly nodeId: string
    readonly branchKey: string
    readonly workflowName: string
    readonly workflowVersion: number
    readonly variables: Readonly<Record<string, unknown>>
  }): Promise<{ readonly childRunId: string }>
}

export interface ExperimentStepper {
  step(input: {
    readonly runId: string
    readonly nodeId: string
    readonly definition: ExperimentDefinition & { readonly version: number }
    readonly rubric: EvaluationRubric & { readonly version: number }
    readonly hypothesis: string
    readonly satisfaction?: WaitSatisfaction
  }): Promise<NodeYield>
}

export interface GraphExecutorDeps {
  readonly run: Run
  readonly item: WorkItem
  readonly snapshot: ResolvedSnapshot
  readonly graph: WorkflowGraph
  readonly executors: ExecutorResolver
  readonly commands: CommandRunner
  readonly actions: ReadonlyMap<string, import('@overture/core').WorkflowAction>
  readonly childRunner: ChildRunner
  readonly experiments?: ExperimentStepper
  readonly workspace?: Workspace
  readonly agentContext: string
  readonly events: EventBus
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly signal: AbortSignal
  readonly onSessionStarted?: (sessionId: string) => void
}

export function resolveProfileFromSnapshot(
  snapshot: ResolvedSnapshot,
  name: string,
): ResolvedProfile {
  const definition = findInSnapshot(snapshot, DefinitionKind.AgentProfile, name)
  if (!definition) {
    throw new OrchestratorError(`agent profile '${name}' not in snapshot`, 'invalid-input')
  }
  const profile = definition.document as unknown as AgentProfileDefinition
  const fragments: ProfileFragment[] = []
  const names: string[] = []
  for (const fragmentName of profile.compose ?? []) {
    const resolved = resolveProfileFromSnapshot(snapshot, fragmentName)
    fragments.push(resolvedToFragment(resolved))
    names.push(fragmentName)
  }
  return composeProfile(profile, fragments, names)
}

function resolvedToFragment(resolved: ResolvedProfile): ProfileFragment {
  return {
    primary: resolved.primary,
    ...(resolved.fallback !== undefined ? { fallback: resolved.fallback } : {}),
    ...(resolved.systemPrompt !== undefined ? { systemPrompt: resolved.systemPrompt } : {}),
    ...(resolved.toolNames !== undefined ? { toolNames: resolved.toolNames } : {}),
    permissions: resolved.permissions,
    ...(resolved.budget !== undefined ? { budget: resolved.budget } : {}),
    ...(resolved.traversal !== undefined ? { traversal: resolved.traversal } : {}),
    ...(resolved.attachments !== undefined ? { attachments: resolved.attachments } : {}),
    ...(resolved.maxTurns !== undefined ? { maxTurns: resolved.maxTurns } : {}),
    ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
  }
}

/** The expression scope shared by action args, sub-workflow inputs, and fan-out items. */
function runScope(context: NodeExecutionContext): {
  vars: Readonly<Record<string, unknown>>
  domain: Readonly<Record<string, unknown>>
  results: Record<string, unknown>
} {
  return {
    vars: context.variables,
    domain: context.domain.data,
    results: Object.fromEntries(
      Object.entries(context.nodeResults).map(([key, result]) => [
        key,
        { status: result.status, outputs: result.outputs },
      ]),
    ),
  }
}

/** Extract a JSON object from an agent's final summary. */
export function parseStructuredOutputs(
  summary: string,
): Readonly<Record<string, unknown>> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(summary)
  const candidates = [fenced?.[1], summary]
  for (const candidate of candidates) {
    if (!candidate) continue
    const trimmed = candidate.trim()
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

export interface ProfileAgentRunOptions {
  readonly context?: string
  readonly toolNames?: readonly string[]
  readonly maxTurns?: number
  readonly timeoutMs?: number
  readonly role?: string
}

export type ProfileAgentRunner = (
  profileName: string | undefined,
  goal: string,
  options?: ProfileAgentRunOptions,
) => Promise<{ outcome: string; summary: string }>

/**
 * Profile-driven agent execution shared by agent nodes, gates, and the
 * experiment stepper: snapshot-pinned profile resolution plus the
 * deterministic fallback chain (outage-only by default, any-failure when
 * the profile opts in).
 */
export function createProfileAgentRunner(deps: GraphExecutorDeps): ProfileAgentRunner {
  return async (
    profileName: string | undefined,
    goal: string,
    options: ProfileAgentRunOptions = {},
  ): Promise<{ outcome: string; summary: string }> => {
    const effectiveProfile = profileName ?? deps.graph.defaultProfile?.name
    if (!effectiveProfile) {
      throw new OrchestratorError(
        'agent node has no profile and the workflow declares no default profile',
        'invalid-input',
      )
    }
    const profile = resolveProfileFromSnapshot(deps.snapshot, effectiveProfile)
    const selections = [profile.primary, ...(profile.fallback?.chain ?? [])]
    let lastError: unknown

    for (const [index, selection] of selections.entries()) {
      const start = deps.executors.get(selection.executor)
      if (!start) {
        lastError = new OrchestratorError(
          `unknown executor '${selection.executor}'`,
          'invalid-input',
        )
        continue
      }
      const sessionId = deps.ids.next('session')
      deps.onSessionStarted?.(sessionId)
      const request: AgentRunRequest = {
        runId: deps.run.id,
        sessionId: sessionId as AgentRunRequest['sessionId'],
        goal: {
          goal,
          context: options.context ?? deps.agentContext,
          ...(options.role !== undefined ? { role: options.role } : {}),
        },
        ...(deps.workspace ? { workspace: deps.workspace } : {}),
        ...(selection.model !== undefined ? { model: selection.model } : {}),
        ...(profile.systemPrompt !== undefined ? { systemPrompt: profile.systemPrompt } : {}),
        ...((options.toolNames ?? profile.toolNames)
          ? { toolNames: options.toolNames ?? profile.toolNames }
          : {}),
        maxTurns: options.maxTurns ?? profile.maxTurns ?? 50,
        ...((options.timeoutMs ?? profile.timeoutMs) !== undefined
          ? { timeoutMs: options.timeoutMs ?? profile.timeoutMs }
          : {}),
        ...(profile.budget !== undefined ? { limits: profile.budget } : {}),
        metadata: { profile: profile.name, executor: selection.executor },
      }
      try {
        const handle = await start(request)
        const abort = () => void handle.cancel('run cancelled')
        deps.signal.addEventListener('abort', abort, { once: true })
        try {
          // Drain events so providers backed by queues never stall.
          void (async () => {
            for await (const _ of handle.events()) {
              // Session events are bridged by the runtime/adapters already.
            }
          })().catch(() => {})
          const result = await handle.result()
          if (result.outcome === 'FATAL_FAILURE' && index < selections.length - 1) {
            const trigger = profile.fallback?.trigger ?? 'outage-only'
            if (trigger === 'any-failure') {
              lastError = new Error(result.summary)
              continue
            }
          }
          return { outcome: result.outcome, summary: result.summary }
        } finally {
          deps.signal.removeEventListener('abort', abort)
        }
      } catch (error) {
        lastError = error
        const category = error instanceof OrchestratorError ? error.category : 'internal'
        const trigger = profile.fallback?.trigger ?? 'outage-only'
        const outage = category === 'provider-outage' || category === 'rate-limit'
        if (index < selections.length - 1 && (trigger === 'any-failure' || outage)) {
          deps.logger.warn('agent executor failed; trying fallback', {
            executor: selection.executor,
            category,
          })
          continue
        }
        throw error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OrchestratorError('all executors in the fallback chain failed', 'provider-outage')
  }
}

export function createGraphNodeExecutors(deps: GraphExecutorDeps): GraphNodeExecutors {
  const runAgent = createProfileAgentRunner(deps)

  const agent: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'agent') throw new Error('expected agent node')
    const config = node.config

    let goal = config.goal
    let extraContext = deps.agentContext
    if (context.satisfaction?.input) {
      extraContext = `${extraContext}\n\n--- Human response to your earlier question ---\n${String(
        context.satisfaction.input.value,
      )}`
    }
    if (config.outputSchema) {
      goal = `${goal}\n\nWhen complete, your final report MUST be a single JSON object conforming to this schema (no extra prose):\n${JSON.stringify(config.outputSchema)}`
    }

    const result = await runAgent(config.profile?.name, goal, {
      context: extraContext,
      ...(config.toolNames ? { toolNames: config.toolNames } : {}),
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      role: node.id,
    })

    if (result.outcome === 'HUMAN_INPUT_REQUIRED') {
      return {
        type: 'wait',
        spec: { kind: 'human-input', parameters: { nodeId: node.id } },
        request: {
          type: 'free-form',
          prompt: result.summary,
          surface: 'both',
        },
      }
    }
    if (result.outcome !== 'GOAL_COMPLETED') {
      return {
        type: 'result',
        status: 'failed',
        outputs: { summary: result.summary, outcome: result.outcome },
        error: `${result.outcome}: ${result.summary.slice(0, 300)}`,
      }
    }

    let outputs: Readonly<Record<string, unknown>> = {
      summary: result.summary,
      outcome: result.outcome,
    }
    if (config.outputSchema) {
      const structured = parseStructuredOutputs(result.summary)
      if (!structured) {
        return {
          type: 'result',
          status: 'failed',
          outputs,
          error: 'agent did not produce the required structured output',
        }
      }
      outputs = { ...structured, summary: result.summary }
    }
    return { type: 'result', status: 'succeeded', outputs }
  }

  const command: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'command') throw new Error('expected command node')
    const cwd = deps.workspace?.path
    if (!cwd)
      return { type: 'result', status: 'failed', error: 'command node requires a workspace' }
    const result = await deps.commands.run(node.config.command, {
      cwd: node.config.cwd ? `${cwd}/${node.config.cwd}` : cwd,
      ...(node.config.env ? { env: node.config.env } : {}),
      ...(node.config.timeoutMs !== undefined ? { timeoutMs: node.config.timeoutMs } : {}),
      signal: context.signal,
    })
    const outputs = { exitCode: result.exitCode, output: result.output }
    return result.exitCode === 0
      ? { type: 'result', status: 'succeeded', outputs }
      : {
          type: 'result',
          status: 'failed',
          outputs,
          error: `command exited with code ${result.exitCode}`,
        }
  }

  const action: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'action') throw new Error('expected action node')
    if (node.config.action === 'workflow.noop') {
      return { type: 'result', status: 'succeeded', outputs: {} }
    }
    const implementation = deps.actions.get(node.config.action)
    if (!implementation) {
      return {
        type: 'result',
        status: 'failed',
        error: `unknown workflow action: ${node.config.action}`,
      }
    }
    // '$expr:' prefixed string arguments evaluate against the run scope —
    // an explicit, deterministic opt-in (never shell-interpolated).
    const args: Record<string, unknown> = {}
    const argScope = runScope(context)
    for (const [key, value] of Object.entries(node.config.with ?? {})) {
      args[key] =
        typeof value === 'string' && value.startsWith('$expr:')
          ? evaluateScopeValue(value.slice('$expr:'.length), argScope)
          : value
    }
    try {
      const outputs = await implementation.execute(args, {
        runId: String(deps.run.id),
        variables: context.variables,
        stepResults: new Map(),
        signal: context.signal,
      })
      return { type: 'result', status: 'succeeded', outputs }
    } catch (error) {
      return {
        type: 'result',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const humanInput: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'human-input') throw new Error('expected human-input node')
    if (context.satisfaction?.input) {
      return {
        type: 'result',
        status: 'succeeded',
        outputs: { value: context.satisfaction.input.value },
      }
    }
    return {
      type: 'wait',
      spec: {
        kind: node.config.request.type === 'approval' ? 'approval' : 'human-input',
        parameters: { nodeId: node.id },
      },
      request: node.config.request,
    }
  }

  const wait: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'wait') throw new Error('expected wait node')
    if (context.satisfaction) {
      return {
        type: 'result',
        status: 'succeeded',
        outputs: { ...(context.satisfaction.event ?? {}) },
      }
    }
    return { type: 'wait', spec: node.config.condition }
  }

  const terminal: GraphNodeExecutor = async () => ({
    type: 'result',
    status: 'succeeded',
    outputs: {},
  })

  const gate: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'gate') throw new Error('expected gate node')
    return evaluateGateNode(node.config, node.id, context, deps, runAgent)
  }

  const subworkflow: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'subworkflow') throw new Error('expected subworkflow node')
    if (context.satisfaction?.event) {
      return childCompletionResult(context.satisfaction.event)
    }
    const definition = findInSnapshot(
      deps.snapshot,
      DefinitionKind.Workflow,
      node.config.workflow.name,
      node.config.workflow.version,
    )
    if (!definition) {
      return {
        type: 'result',
        status: 'failed',
        error: `sub-workflow '${node.config.workflow.name}' not in snapshot`,
      }
    }
    const variables: Record<string, unknown> = {}
    for (const [key, expression] of Object.entries(node.config.inputs ?? {})) {
      variables[key] = evaluateScopeValue(expression, runScope(context))
    }
    const { childRunId } = await deps.childRunner.start({
      parentRunId: String(deps.run.id),
      nodeId: node.id,
      branchKey: 'main',
      workflowName: definition.name,
      workflowVersion: definition.version,
      variables,
    })
    return {
      type: 'wait',
      spec: {
        kind: 'dependency',
        parameters: { childRunIds: [childRunId], join: { mode: 'all' } },
      },
    }
  }

  const fanOut: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'fan-out') throw new Error('expected fan-out node')
    if (context.satisfaction?.event) {
      return childCompletionResult(context.satisfaction.event)
    }
    const items = evaluateScopeValue(node.config.items, runScope(context))
    if (!Array.isArray(items)) {
      return {
        type: 'result',
        status: 'failed',
        error: `fan-out items expression did not produce a list: ${node.config.items}`,
      }
    }
    if (items.length === 0) {
      return { type: 'result', status: 'succeeded', outputs: { branches: [] } }
    }
    // The branch workflow runs at the version pinned into the snapshot.
    const branchDefinition = findInSnapshot(
      deps.snapshot,
      DefinitionKind.Workflow,
      node.config.workflow.name,
      node.config.workflow.version,
    )
    if (!branchDefinition) {
      return {
        type: 'result',
        status: 'failed',
        error: `fan-out workflow '${node.config.workflow.name}' not in snapshot`,
      }
    }
    const childRunIds: string[] = []
    for (const [index, item] of items.entries()) {
      const { childRunId } = await deps.childRunner.start({
        parentRunId: String(deps.run.id),
        nodeId: node.id,
        branchKey: String(index),
        workflowName: branchDefinition.name,
        workflowVersion: branchDefinition.version,
        variables: { item, branch: index },
      })
      childRunIds.push(childRunId)
    }
    return {
      type: 'wait',
      spec: {
        kind: 'dependency',
        parameters: { childRunIds, join: node.config.join satisfies JoinSpec },
      },
    }
  }

  const experiment: GraphNodeExecutor = async (node, context) => {
    if (node.config.kind !== 'experiment') throw new Error('expected experiment node')
    if (!deps.experiments) {
      return { type: 'result', status: 'failed', error: 'experiment support is not configured' }
    }
    const definition = findInSnapshot(
      deps.snapshot,
      DefinitionKind.Experiment,
      node.config.experiment.name,
      node.config.experiment.version,
    )
    if (!definition) {
      return {
        type: 'result',
        status: 'failed',
        error: `experiment '${node.config.experiment.name}' not in snapshot`,
      }
    }
    const experimentDoc = definition.document as unknown as ExperimentDefinition
    const rubricName = node.config.rubric?.name ?? experimentDoc.rubric
    const rubricDefinition = findInSnapshot(deps.snapshot, DefinitionKind.Rubric, rubricName)
    if (!rubricDefinition) {
      return {
        type: 'result',
        status: 'failed',
        error: `rubric '${rubricName}' not in snapshot`,
      }
    }
    const fromDomain = context.domain.data['hypothesis']
    const fromVariables = context.variables['hypothesis']
    const hypothesis =
      typeof fromDomain === 'string'
        ? fromDomain
        : typeof fromVariables === 'string'
          ? fromVariables
          : deps.item.title
    return deps.experiments.step({
      runId: String(deps.run.id),
      nodeId: node.id,
      definition: { ...experimentDoc, version: definition.version },
      rubric: {
        ...(rubricDefinition.document as unknown as EvaluationRubric),
        version: rubricDefinition.version,
      },
      hypothesis,
      ...(context.satisfaction ? { satisfaction: context.satisfaction } : {}),
    })
  }

  return {
    agent,
    command,
    action,
    gate,
    'human-input': humanInput,
    wait,
    subworkflow,
    experiment,
    'fan-out': fanOut,
    terminal,
  }
}

function childCompletionResult(event: Readonly<Record<string, unknown>>): NodeYield {
  const failedBranches = event['failedBranches']
  const succeeded = event['succeeded'] === true
  return {
    type: 'result',
    status: succeeded ? 'succeeded' : 'failed',
    outputs: { ...event },
    ...(succeeded
      ? {}
      : {
          error: `child runs failed: ${Array.isArray(failedBranches) ? failedBranches.join(', ') : 'unknown'}`,
        }),
  }
}

async function evaluateGateNode(
  config: Extract<import('@overture/core').GraphNodeConfig, { kind: 'gate' }>,
  nodeId: string,
  context: NodeExecutionContext,
  deps: GraphExecutorDeps,
  runAgent: (
    profileName: string | undefined,
    goal: string,
    options?: { readonly context?: string; readonly role?: string },
  ) => Promise<{ outcome: string; summary: string }>,
): Promise<NodeYield> {
  const gateSetDefinition = findInSnapshot(
    deps.snapshot,
    DefinitionKind.GateSet,
    config.gateSet.name,
    config.gateSet.version,
  )
  if (!gateSetDefinition) {
    return {
      type: 'result',
      status: 'failed',
      error: `gate set '${config.gateSet.name}' not in snapshot`,
    }
  }
  const gateSet = gateSetDefinition.document as unknown as GateSet
  const bases: GateSet[] = []
  for (const baseName of gateSet.extends ?? []) {
    const base = findInSnapshot(deps.snapshot, DefinitionKind.GateSet, baseName)
    if (base) bases.push(base.document as unknown as GateSet)
  }
  const gates = composeGateSets(gateSet, bases)

  // Human gates suspend; the coordinator injects the pending gate id into
  // the satisfaction event when the approval arrives.
  const approvedGateId =
    context.satisfaction?.event?.['gateId'] !== undefined
      ? String(context.satisfaction.event['gateId'])
      : undefined
  const humanApproval =
    context.satisfaction?.input?.value === true
      ? 'approved'
      : context.satisfaction?.input !== undefined
        ? 'rejected'
        : undefined

  const evaluations: GateEvaluation[] = []
  const results: Record<string, unknown> = {}
  for (const [nodeIdKey, result] of Object.entries(context.nodeResults)) {
    results[nodeIdKey] = {
      status: result.status,
      succeeded: result.status === 'succeeded',
      failed: result.status === 'failed',
      outputs: result.outputs,
    }
  }
  const scope = {
    item: {
      title: deps.item.title,
      state: deps.item.state,
      type: deps.item.type ?? '',
      labels: deps.item.labels,
      description: deps.item.description ?? '',
    },
    domain: context.domain.data,
    vars: context.variables,
    results,
  }

  const evaluateOnce = async (gate: Gate, attempt: number): Promise<GateEvaluation> => {
    const at = deps.clock.now()
    if (gate.kind === 'deterministic') {
      if (gate.check.startsWith('command:')) {
        const cwd = deps.workspace?.path
        if (!cwd) {
          return {
            gateId: gate.id,
            passed: false,
            reason: 'no workspace for command gate',
            evaluatedBy: 'command',
            attempt,
            at,
          }
        }
        const result = await deps.commands.run(gate.check.slice('command:'.length).trim(), {
          cwd,
          signal: context.signal,
        })
        return {
          gateId: gate.id,
          passed: result.exitCode === 0,
          reason:
            result.exitCode === 0
              ? 'command passed'
              : `exit ${result.exitCode}: ${result.output.slice(-300)}`,
          evaluatedBy: 'command',
          attempt,
          at,
        }
      }
      let passed = false
      let reason = ''
      try {
        passed = evaluateScopeExpression(gate.check, scope)
        reason = passed ? 'expression true' : `expression false: ${gate.check}`
      } catch (error) {
        reason = `expression error: ${error instanceof Error ? error.message : String(error)}`
      }
      return { gateId: gate.id, passed, reason, evaluatedBy: 'expression', attempt, at }
    }
    if (gate.kind === 'agent') {
      const result = await runAgent(
        config.remediationProfile?.name,
        `${gate.check}\n\nRespond with a JSON object: {"passed": true|false, "reason": "..."}`,
        { role: `gate:${gate.id}` },
      )
      const structured = parseStructuredOutputs(result.summary)
      const passed = structured?.['passed'] === true
      return {
        gateId: gate.id,
        passed,
        reason: String(structured?.['reason'] ?? result.summary.slice(0, 300)),
        evaluatedBy: 'agent',
        attempt,
        at,
      }
    }
    // human gate: consume a matching approval satisfaction, else suspend.
    if (humanApproval !== undefined && approvedGateId === gate.id) {
      return {
        gateId: gate.id,
        passed: humanApproval === 'approved',
        reason: `human ${humanApproval}`,
        evaluatedBy: 'human',
        attempt,
        at,
      }
    }
    throw new HumanGatePending(gate)
  }

  let remediationsAttempted = 0
  const maxRemediation = config.maxRemediationAttempts ?? 0

  try {
    for (const gate of gates) {
      let attempt = 1
      let evaluation = await evaluateOnce(gate, attempt)
      // Bounded remediation with independent re-evaluation: the
      // remediator never declares success — evaluateOnce runs again.
      while (
        !evaluation.passed &&
        gate.required &&
        gate.remediation &&
        remediationsAttempted < maxRemediation &&
        attempt <= gate.remediation.maxAttempts
      ) {
        remediationsAttempted += 1
        await runAgent(
          config.remediationProfile?.name,
          `${gate.remediation.goal}\n\nThe gate '${gate.id}' failed: ${evaluation.reason}`,
          { role: `remediate:${gate.id}` },
        )
        attempt += 1
        evaluation = await evaluateOnce(gate, attempt)
      }
      evaluations.push(evaluation)
      if (!evaluation.passed && gate.required) {
        return {
          type: 'result',
          status: 'failed',
          outputs: gateOutputs(
            gateSet.name,
            gateSetDefinition.version,
            false,
            evaluations,
            remediationsAttempted,
          ),
          error: `gate '${gate.id}' failed: ${evaluation.reason}`,
        }
      }
    }
  } catch (error) {
    if (error instanceof HumanGatePending) {
      return {
        type: 'wait',
        spec: { kind: 'approval', parameters: { nodeId, gateId: error.gate.id } },
        request: {
          type: 'approval',
          prompt: error.gate.check,
          surface: 'both',
        },
      }
    }
    throw error
  }

  return {
    type: 'result',
    status: 'succeeded',
    outputs: gateOutputs(
      gateSet.name,
      gateSetDefinition.version,
      true,
      evaluations,
      remediationsAttempted,
    ),
  }
}

class HumanGatePending extends Error {
  constructor(readonly gate: Gate) {
    super(`human gate pending: ${gate.id}`)
  }
}

function gateOutputs(
  gateSetName: string,
  gateSetVersion: number,
  passed: boolean,
  evaluations: readonly GateEvaluation[],
  remediationsAttempted: number,
) {
  return {
    gateSetName,
    gateSetVersion,
    passed,
    evaluations: evaluations.map((evaluation) => ({
      ...evaluation,
      at: evaluation.at.toISOString(),
    })),
    remediationsAttempted,
  }
}
