/**
 * Workflow graph model (ADR-0017): typed nodes joined by declared
 * transitions. Agents reason inside nodes and return structured outputs;
 * the engine — never a model — evaluates conditions and selects among the
 * transitions declared here. The graph is immutable for a running
 * workflow version.
 */

import type { WorkflowEligibility, WorkflowTrigger } from './workflow.js'

export const GraphNodeKind = {
  Agent: 'agent',
  Command: 'command',
  Action: 'action',
  Gate: 'gate',
  HumanInput: 'human-input',
  Wait: 'wait',
  Subworkflow: 'subworkflow',
  Experiment: 'experiment',
  FanOut: 'fan-out',
  Terminal: 'terminal',
} as const

export type GraphNodeKind = (typeof GraphNodeKind)[keyof typeof GraphNodeKind]

/** Reference to a versioned definition; resolved into the run snapshot. */
export interface DefinitionRef {
  readonly name: string
  /** Omitted = latest ENABLED version at snapshot time. */
  readonly version?: number
}

export interface AgentNodeConfig {
  readonly kind: 'agent'
  readonly goal: string
  /** Agent profile reference; falls back to the workflow default. */
  readonly profile?: DefinitionRef
  /**
   * JSON schema for the node's structured output. The agent must produce
   * a conforming object; transitions may reference `outputs.<key>`.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>
  readonly toolNames?: readonly string[]
  readonly maxTurns?: number
  readonly timeoutMs?: number
}

export interface CommandNodeConfig {
  readonly kind: 'command'
  readonly command: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface ActionNodeConfig {
  readonly kind: 'action'
  readonly action: string
  readonly with?: Readonly<Record<string, unknown>>
}

export interface GateNodeConfig {
  readonly kind: 'gate'
  /** Versioned gate set (Definition of Ready / Done / custom). */
  readonly gateSet: DefinitionRef
  /**
   * Bounded auto-remediation: when a gate fails and defines remediation,
   * run it at most this many times, re-evaluating independently after
   * each attempt. 0 disables remediation at this node.
   */
  readonly maxRemediationAttempts?: number
  readonly remediationProfile?: DefinitionRef
}

export interface HumanInputNodeConfig {
  readonly kind: 'human-input'
  readonly request: HumanInputRequestSpec
}

export interface WaitNodeConfig {
  readonly kind: 'wait'
  readonly condition: WaitSpec
}

export interface SubworkflowNodeConfig {
  readonly kind: 'subworkflow'
  readonly workflow: DefinitionRef
  /** Expressions mapped into the child's initial variables. */
  readonly inputs?: Readonly<Record<string, string>>
}

export interface ExperimentNodeConfig {
  readonly kind: 'experiment'
  readonly experiment: DefinitionRef
  /** Rubric override; defaults to the experiment definition's rubric. */
  readonly rubric?: DefinitionRef
}

export interface FanOutNodeConfig {
  readonly kind: 'fan-out'
  /** Expression producing the list of items to fan out over. */
  readonly items: string
  /** Sub-workflow executed once per item (item bound as `vars.item`). */
  readonly workflow: DefinitionRef
  readonly join: JoinSpec
  readonly maxConcurrency?: number
}

export interface JoinSpec {
  readonly mode: 'all' | 'any' | 'min'
  /** Required when mode is 'min'. */
  readonly n?: number
  /** Branch labels (item keys) that must succeed regardless of mode. */
  readonly required?: readonly string[]
}

export interface TerminalNodeConfig {
  readonly kind: 'terminal'
  readonly outcome: 'completed' | 'failed' | 'blocked'
}

export type GraphNodeConfig =
  | AgentNodeConfig
  | CommandNodeConfig
  | ActionNodeConfig
  | GateNodeConfig
  | HumanInputNodeConfig
  | WaitNodeConfig
  | SubworkflowNodeConfig
  | ExperimentNodeConfig
  | FanOutNodeConfig
  | TerminalNodeConfig

/** Declarative side effects attached to node entry/exit or transitions. */
export interface LifecycleEffect {
  /** Set the run's domain state name. */
  readonly setDomainState?: string
  /** Merge expression-valued entries into the domain data bag. */
  readonly setData?: Readonly<Record<string, string>>
  /** Project onto the external work item (state name or action id). */
  readonly project?: string
}

export interface GraphNode {
  readonly id: string
  readonly config: GraphNodeConfig
  /**
   * Activation semantics for nodes with multiple incoming transitions:
   * 'any' (default) activates on the first firing; 'all' waits for every
   * incoming transition to fire; 'min' waits for `join.n`. Validation
   * forbids 'all'/'min' joins on nodes inside cycles.
   */
  readonly join?: JoinSpec
  /** Guard expressions; all must be true or the node fails pre-execution. */
  readonly guards?: readonly string[]
  readonly onEnter?: LifecycleEffect
  readonly onExit?: LifecycleEffect
  readonly retry?: { readonly maxAttempts: number; readonly backoffMs?: number }
}

export interface GraphTransition {
  readonly id: string
  readonly from: string
  readonly to: string
  /**
   * Expression over `outputs` (the settled node's structured outputs),
   * `node` (its status), `domain`, and `vars`. Absent = unconditional.
   */
  readonly condition?: string
  /**
   * Required on any transition that can re-enter earlier graph regions:
   * maximum traversals per run. The engine fails the run rather than
   * exceed it. Validation rejects cyclic transitions without a bound.
   */
  readonly loopBound?: number
  readonly effects?: LifecycleEffect
}

/** Projection of internal state onto the external work item (ADR-0017). */
export interface ExternalProjection {
  /** Domain/engine state name → external target state. */
  readonly states?: Readonly<Record<string, string>>
  /** Post comments for these engine events (paused, waiting, resumed…). */
  readonly comments?: readonly string[]
  /** Keep a managed section in the work-item body up to date. */
  readonly managedSection?: boolean
}

export interface WorkflowGraph {
  readonly name: string
  readonly description?: string
  readonly entry: string
  readonly nodes: readonly GraphNode[]
  readonly transitions: readonly GraphTransition[]
  /** Declared domain states (open set; declaration aids validation/UI). */
  readonly domainStates?: readonly string[]
  readonly projection?: ExternalProjection
  readonly trigger?: WorkflowTrigger
  readonly eligibility?: WorkflowEligibility
  readonly defaultProfile?: DefinitionRef
  readonly variables?: Readonly<Record<string, string>>
  readonly workspace?: {
    readonly strategy: string
    readonly retention?: 'always' | 'on-failure' | 'never'
  }
}

// ---------------------------------------------------------------------------
// Waits and human input (ADR-0019) — specs referenced by graph nodes.
// ---------------------------------------------------------------------------

export type WaitKind =
  | 'human-input'
  | 'approval'
  | 'time'
  | 'external-event'
  | 'dependency'
  | 'provider-availability'
  | 'work-item-event'

export interface WaitSpec {
  readonly kind: WaitKind
  /**
   * Kind-specific parameters: `time` uses untilExpression/afterMs;
   * `external-event`/`work-item-event` use an event name/filter;
   * `dependency` uses a work-item reference expression;
   * `provider-availability` uses a provider id.
   */
  readonly parameters: Readonly<Record<string, unknown>>
  readonly timeoutMs?: number
}

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
  /** Where the request surfaces. */
  readonly surface: 'app' | 'work_item' | 'both'
  readonly choices?: readonly string[]
  /** Secret name to store the value under (type 'secret' only). */
  readonly secretName?: string
  readonly timeoutMs?: number
}
