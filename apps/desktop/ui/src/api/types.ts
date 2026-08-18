/**
 * Wire types for the Overture control-plane HTTP API.
 *
 * Deliberately hand-mirrored from `@overture/core` / `@overture/server`
 * rather than imported: this app talks to the daemon exclusively over HTTP
 * and must stay buildable as a standalone bundle embedded in the Tauri
 * shell, independent of the monorepo's internal packages. Date fields cross
 * the wire as ISO strings (JSON has no Date type), so every `Date` in the
 * source contracts is a `string` here.
 */

export const RunState = {
  Queued: 'QUEUED',
  Preparing: 'PREPARING',
  Running: 'RUNNING',
  WaitingForTool: 'WAITING_FOR_TOOL',
  WaitingForSubagent: 'WAITING_FOR_SUBAGENT',
  WaitingForHuman: 'WAITING_FOR_HUMAN',
  Verifying: 'VERIFYING',
  Completed: 'COMPLETED',
  Failed: 'FAILED',
  Blocked: 'BLOCKED',
  Cancelled: 'CANCELLED',
} as const

export type RunState = (typeof RunState)[keyof typeof RunState]

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  RunState.Completed,
  RunState.Failed,
  RunState.Blocked,
  RunState.Cancelled,
]

export interface RunStateChange {
  readonly from: RunState
  readonly to: RunState
  readonly at: string
  readonly reason?: string
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface UsageRecord {
  readonly provider: string
  readonly model?: string
  readonly tokens: TokenUsage
  readonly estimatedCostUsd?: number
  readonly subscriptionRequests?: number
  readonly durationMs: number
  readonly turns: number
  readonly subagents: number
}

export type AgentOutcome =
  | 'GOAL_COMPLETED'
  | 'GOAL_BLOCKED'
  | 'BUDGET_EXHAUSTED'
  | 'POLICY_BLOCKED'
  | 'HUMAN_INPUT_REQUIRED'
  | 'FATAL_FAILURE'
  | 'CANCELLED'

export interface Run {
  readonly id: string
  readonly workItemId: string
  readonly workflowName: string
  readonly state: RunState
  readonly currentStepId?: string
  readonly workspaceId?: string
  readonly sessionIds: readonly string[]
  readonly usage?: UsageRecord
  readonly outcome?: AgentOutcome
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly history: readonly RunStateChange[]
}

export interface AgentResult {
  readonly outcome: AgentOutcome
  readonly summary: string
  readonly usage: UsageRecord
  readonly providerSessionId?: string
}

export type AgentEvent =
  | { readonly type: 'agent.started'; readonly sessionId: string }
  | { readonly type: 'agent.turn.started'; readonly turn: number }
  | { readonly type: 'agent.text'; readonly text: string }
  | { readonly type: 'agent.thinking'; readonly text: string }
  | {
      readonly type: 'agent.tool.started'
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly type: 'agent.tool.completed'
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
      readonly content: string
    }
  | { readonly type: 'agent.subagent.started'; readonly childSessionId: string }
  | {
      readonly type: 'agent.subagent.completed'
      readonly childSessionId: string
      readonly outcome: AgentOutcome
    }
  | { readonly type: 'agent.waiting.human'; readonly reason: string }
  | { readonly type: 'agent.usage'; readonly usage: TokenUsage; readonly model: string }
  | { readonly type: 'agent.completed'; readonly result: AgentResult }

export interface BudgetStatus {
  readonly budgetId: string
  readonly exhausted: boolean
  readonly exhaustedDimensions: readonly string[]
  readonly warningDimensions: readonly string[]
}

export type OrchestratorEventPayload =
  | { readonly type: 'work.discovered'; readonly workItemId: string; readonly provider: string }
  | { readonly type: 'work.claimed'; readonly workItemId: string; readonly runId: string }
  | { readonly type: 'work.claim.rejected'; readonly workItemId: string; readonly reason: string }
  | { readonly type: 'work.updated'; readonly workItemId: string; readonly detail: string }
  | { readonly type: 'workspace.created'; readonly workspaceId: string; readonly path: string }
  | { readonly type: 'workspace.cleaned'; readonly workspaceId: string }
  | {
      readonly type: 'run.state.changed'
      readonly runId: string
      readonly from: RunState
      readonly to: RunState
      readonly reason?: string
    }
  | { readonly type: 'workflow.step.started'; readonly runId: string; readonly stepId: string }
  | {
      readonly type: 'workflow.step.completed'
      readonly runId: string
      readonly stepId: string
      readonly status: 'succeeded' | 'failed' | 'skipped'
    }
  | { readonly type: 'workflow.transitioned'; readonly runId: string; readonly transition: string }
  | {
      readonly type: 'model.request.started'
      readonly sessionId: string
      readonly provider: string
      readonly model: string
    }
  | {
      readonly type: 'model.request.completed'
      readonly sessionId: string
      readonly provider: string
      readonly model: string
      readonly durationMs: number
      readonly inputTokens: number
      readonly outputTokens: number
    }
  | { readonly type: 'agent'; readonly sessionId: string; readonly event: AgentEvent }
  | { readonly type: 'validation.failed'; readonly runId: string; readonly detail: string }
  | { readonly type: 'delivery.pull_request.created'; readonly runId: string; readonly url: string }
  | { readonly type: 'budget.warning'; readonly status: BudgetStatus }
  | { readonly type: 'budget.exhausted'; readonly status: BudgetStatus }
  | {
      readonly type: 'approval.requested'
      readonly runId: string
      readonly requestId: string
      readonly description: string
    }
  | {
      readonly type: 'approval.resolved'
      readonly runId: string
      readonly requestId: string
      readonly approved: boolean
    }
  | { readonly type: 'error'; readonly scope: string; readonly message: string }

export type OrchestratorEvent = OrchestratorEventPayload & {
  readonly id: string
  readonly at: string
  readonly runId?: string
}

export type OrchestratorEventType = OrchestratorEventPayload['type']

// ----- work items ----------------------------------------------------------

export interface Identity {
  readonly id: string
  readonly displayName?: string
  readonly email?: string
}

export type WorkRelationshipKind =
  | 'blocks'
  | 'blocked-by'
  | 'relates-to'
  | 'parent-of'
  | 'child-of'
  | 'duplicates'

export interface WorkRelationship {
  readonly kind: WorkRelationshipKind
  readonly targetExternalId: string
}

export interface RepositoryReference {
  readonly locator: string
  readonly defaultBranch?: string
  readonly scmProviderId?: string
}

export interface WorkItem {
  readonly id: string
  readonly provider: string
  readonly externalId: string
  readonly title: string
  readonly description?: string
  readonly state: string
  readonly type?: string
  readonly priority?: string
  readonly labels: readonly string[]
  readonly assignees: readonly Identity[]
  readonly relationships: readonly WorkRelationship[]
  readonly repository?: RepositoryReference
  readonly metadata: Readonly<Record<string, unknown>>
  readonly url?: string
  readonly updatedAt?: string
}

// ----- providers -------------------------------------------------------

export type ConsumptionModel = 'api-usage' | 'subscription' | 'local' | 'free'

export type AuthenticationKind =
  | 'api-key'
  | 'oauth'
  | 'device-code'
  | 'cli-session'
  | 'cloud-credentials'
  | 'none'

export interface ProviderInfo {
  readonly id: string
  readonly displayName: string
  readonly kind: 'model' | 'agent' | 'work' | 'scm' | 'workspace' | 'secret' | 'notification'
  readonly consumption: ConsumptionModel
  readonly authentication: readonly AuthenticationKind[]
}

export interface ProviderAvailability {
  readonly installed: boolean
  readonly authenticated: boolean
  readonly available: boolean
  readonly authenticationKind?: AuthenticationKind
  readonly detail?: string
  readonly models?: readonly string[]
}

export interface ProviderStatus {
  readonly info: ProviderInfo
  readonly availability: ProviderAvailability
}

// ----- workflows -------------------------------------------------------

export interface WorkflowTrigger {
  readonly states?: readonly string[]
  readonly labels?: readonly string[]
}

export interface WorkflowEligibility {
  readonly labelsInclude?: readonly string[]
  readonly labelsExclude?: readonly string[]
  readonly types?: readonly string[]
  readonly assignee?: string
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
  readonly when?: string
  readonly timeoutMs?: number
  readonly retry?: RetryPolicy
  readonly continueOnFailure?: boolean
}

export interface AgentStep extends BaseStep {
  readonly kind: 'agent'
  readonly agent: string
  readonly goal: string
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
  readonly action: string
  readonly with?: Readonly<Record<string, unknown>>
}

export interface ApprovalStep extends BaseStep {
  readonly kind: 'approval'
  readonly description: string
}

export type WorkflowStep = AgentStep | CommandStep | ActionStep | ApprovalStep

export interface WorkflowTransitions {
  readonly success?: string
  readonly failure?: string
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

export interface WorkflowValidationResult {
  readonly valid: boolean
  readonly issues: readonly string[]
}

// ----- approvals -------------------------------------------------------

export interface PermissionRequest {
  readonly capability: string
  readonly target?: string
  readonly runId?: string
  readonly toolName?: string
}

export type PolicyEffect = 'allow' | 'deny' | 'ask'

export interface PolicyDecision {
  readonly effect: PolicyEffect
  readonly reason?: string
  readonly ruleId?: string
}

export interface PendingApproval {
  readonly id: string
  readonly request: PermissionRequest
  readonly decision: PolicyDecision
  readonly requestedAt: string
}

// ----- durable waits (Phase 2) -------------------------------------------

export type WaitKind =
  | 'human-input'
  | 'approval'
  | 'time'
  | 'external-event'
  | 'dependency'
  | 'provider-availability'
  | 'work-item-event'

export type HumanInputType =
  | 'text'
  | 'boolean'
  | 'single-choice'
  | 'multiple-choice'
  | 'approval'
  | 'secret'
  | 'file-reference'
  | 'free-form'

export interface HumanInputRequestSpec {
  readonly type: HumanInputType
  readonly prompt: string
  readonly surface: 'app' | 'work_item' | 'both'
  readonly choices?: readonly string[]
  readonly secretName?: string
  readonly timeoutMs?: number
}

export type WaitConditionStatus = 'open' | 'satisfied' | 'expired' | 'cancelled'

export interface WaitCondition {
  readonly id: string
  readonly runId: string
  readonly nodeId: string
  readonly kind: WaitKind
  readonly parameters: Readonly<Record<string, unknown>>
  readonly request?: HumanInputRequestSpec
  readonly status: WaitConditionStatus
  readonly createdAt: string
  readonly dueAt?: string
}

/** `parameters.reason` value marking a wait as an experiment judgment. */
export const EXPERIMENT_JUDGMENT_REASON = 'EXPERIMENT_JUDGMENT_REQUIRED'
/** `parameters.reason` value marking a wait as a workflow selection. */
export const WORKFLOW_SELECTION_REASON = 'WORKFLOW_SELECTION_REQUIRED'

/** Summary of the response that won a wait's first-valid-response race. */
export interface WaitWinner {
  readonly at: string
  readonly responder?: string
  readonly channel?: string
  readonly value?: unknown
}

export type WaitRespondResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false
      readonly status: number
      readonly error: string
      readonly winner?: WaitWinner
    }

// ----- experiments / judgments -------------------------------------------

export interface JudgmentSurvivor {
  readonly candidateId: string
  readonly title: string
  readonly summary: string
  readonly weightedScore: number
  readonly artifacts: Readonly<Record<string, string>>
  readonly keyEvidence: readonly string[]
}

export interface JudgmentPackage {
  readonly experimentId: string
  readonly hypothesis: string
  readonly rubricSummary: string
  readonly killCriteria: readonly string[]
  readonly survivors: readonly JudgmentSurvivor[]
  readonly recommendation: string
  readonly risks: readonly string[]
  readonly iteration: number
  readonly maxIterations: number
}

export type JudgmentDecision = 'kill' | 'advance' | 'iterate' | 'need-more-evidence'

export interface JudgmentOutcome {
  readonly experimentId: string
  readonly decision: JudgmentDecision
  readonly selectedCandidateId?: string
  readonly feedback?: string
  readonly decidedBy: string
  readonly at: string
}

// ----- durable graph runs ------------------------------------------------

export type GraphNodeStatus = 'succeeded' | 'failed' | 'skipped'

export interface GraphNodeResult {
  readonly nodeId: string
  readonly attempt: number
  readonly status: GraphNodeStatus
  readonly outputs: Readonly<Record<string, unknown>>
  readonly error?: string
  readonly startedAt: string
  readonly settledAt: string
}

export interface DomainState {
  readonly name?: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface RunGraphState {
  readonly runId: string
  readonly snapshotId: string
  readonly activeNodeIds: readonly string[]
  readonly waitingNodeIds: readonly string[]
  readonly nodeResults: Readonly<Record<string, GraphNodeResult>>
  /** Newest-first as served by GET /api/graph-runs/:id. */
  readonly resultHistory: readonly GraphNodeResult[]
  readonly loopCounters: Readonly<Record<string, number>>
  readonly activations: Readonly<Record<string, number>>
  readonly domain: DomainState
  readonly variables: Readonly<Record<string, unknown>>
  readonly specRevision: number
  readonly updatedAt: string
}

export interface GraphRunView {
  readonly run?: Run
  readonly state: RunGraphState
  readonly openWaits: readonly WaitCondition[]
}

// ----- status / misc -----------------------------------------------------

export interface ServiceStatus {
  readonly version: string
  readonly startedAt: string
  readonly activeRuns: number
  readonly workSources: readonly string[]
  readonly workflows: readonly string[]
}
