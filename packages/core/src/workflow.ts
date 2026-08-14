/**
 * Workflow definition model: the parsed, validated representation of a
 * declarative workflow. Parsing/validation of the YAML format lives in the
 * workflow package; these types are the stable contract.
 */

export interface WorkflowTrigger {
  readonly states?: readonly string[]
  readonly labels?: readonly string[]
}

export interface WorkflowEligibility {
  readonly labelsInclude?: readonly string[]
  readonly labelsExclude?: readonly string[]
  readonly types?: readonly string[]
  readonly assignee?: 'unassigned' | 'any' | string
}

export interface WorkflowWorkspaceConfig {
  readonly strategy: string
  readonly retention?: 'always' | 'on-failure' | 'never'
}

export type StepKind = 'agent' | 'command' | 'action' | 'approval'

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly backoffMs?: number
}

interface BaseStep {
  readonly id: string
  readonly kind: StepKind
  readonly dependsOn?: readonly string[]
  /** Expression over prior step results / variables, e.g. `review.failed`. */
  readonly when?: string
  readonly timeoutMs?: number
  readonly retry?: RetryPolicy
  readonly continueOnFailure?: boolean
}

export interface AgentStep extends BaseStep {
  readonly kind: 'agent'
  /** Configured agent role (planner, coder, reviewer, …). */
  readonly agent: string
  readonly goal: string
  /** Routing profile name or explicit provider/model selection. */
  readonly route?: string
  readonly toolNames?: readonly string[]
  readonly maxTurns?: number
}

export interface CommandStep extends BaseStep {
  readonly kind: 'command'
  readonly command: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

export interface ActionStep extends BaseStep {
  readonly kind: 'action'
  /** Registered workflow action, e.g. `source_control.pull_request`. */
  readonly action: string
  readonly with?: Readonly<Record<string, unknown>>
}

export interface ApprovalStep extends BaseStep {
  readonly kind: 'approval'
  readonly description: string
}

export type WorkflowStep = AgentStep | CommandStep | ActionStep | ApprovalStep

export interface WorkflowTransitions {
  /** Target work-item state on overall success. */
  readonly success?: string
  /** Target work-item state on overall failure. */
  readonly failure?: string
  /** Target work-item state when blocked / needs human. */
  readonly blocked?: string
}

export interface WorkflowDefinition {
  readonly name: string
  readonly description?: string
  readonly trigger?: WorkflowTrigger
  readonly eligibility?: WorkflowEligibility
  readonly workspace?: WorkflowWorkspaceConfig
  readonly variables?: Readonly<Record<string, string>>
  readonly steps: readonly WorkflowStep[]
  readonly transitions?: WorkflowTransitions
  readonly budget?: string
}

/** Source of workflow definitions (built-in, user dir, repo file, …). */
export interface WorkflowProvider {
  readonly id: string
  list(): Promise<readonly WorkflowDefinition[]>
  get(name: string): Promise<WorkflowDefinition | undefined>
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface StepResult {
  readonly stepId: string
  readonly status: StepStatus
  /** Step outputs referencable from later steps (`steps.<id>.outputs.<k>`). */
  readonly outputs: Readonly<Record<string, unknown>>
  readonly error?: string
  readonly startedAt?: Date
  readonly finishedAt?: Date
}

/**
 * A registered, composable workflow action (deliver PR, update issue, …).
 * Actions are contributed by packages and extensions, never hardcoded into
 * the engine.
 */
export interface WorkflowAction {
  readonly id: string
  execute(
    args: Readonly<Record<string, unknown>>,
    context: WorkflowActionContext,
  ): Promise<Readonly<Record<string, unknown>>>
}

export interface WorkflowActionContext {
  readonly runId: string
  readonly variables: Readonly<Record<string, unknown>>
  readonly stepResults: ReadonlyMap<string, StepResult>
  readonly signal: AbortSignal
}
