/**
 * Extension contracts: manifest, permissions, and the narrow surface an
 * extension may contribute through (tools, workflow actions, hooks,
 * providers). Extensions are discovered, never compiled into the core.
 */

import type { OrchestratorEvent } from './events.js'
import type { PermissionCapability } from './permissions.js'
import type { Tool } from './tools.js'
import type { WorkflowAction } from './workflow.js'

export interface ExtensionManifest {
  /** Reverse-DNS identifier, e.g. `com.example.security-scan`. */
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly provides: {
    readonly tools?: readonly string[]
    readonly workflowActions?: readonly string[]
    readonly hooks?: readonly HookPoint[]
  }
  readonly permissions: readonly PermissionCapability[]
}

export const HookPoint = {
  BeforeWorkClaim: 'before_work_claim',
  AfterWorkClaim: 'after_work_claim',
  BeforeWorkspaceCreate: 'before_workspace_create',
  AfterWorkspaceCreate: 'after_workspace_create',
  BeforeAgentStart: 'before_agent_start',
  AfterAgentTurn: 'after_agent_turn',
  BeforeToolCall: 'before_tool_call',
  AfterToolCall: 'after_tool_call',
  BeforeSubagent: 'before_subagent',
  AfterSubagent: 'after_subagent',
  BeforeCommit: 'before_commit',
  AfterCommit: 'after_commit',
  BeforePullRequest: 'before_pull_request',
  AfterPullRequest: 'after_pull_request',
  OnFailure: 'on_failure',
  OnComplete: 'on_complete',
  OnCleanup: 'on_cleanup',
} as const

export type HookPoint = (typeof HookPoint)[keyof typeof HookPoint]

export interface HookContext {
  readonly point: HookPoint
  readonly runId?: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly event?: OrchestratorEvent
}

export interface HookOutcome {
  /**
   * `continue` proceeds; `block` vetoes the operation (where the hook point
   * is vetoable). Hooks can never widen permissions or bypass policy.
   */
  readonly action: 'continue' | 'block'
  readonly reason?: string
  /** Optional payload amendments merged into the operation context. */
  readonly amend?: Readonly<Record<string, unknown>>
}

export type HookHandler = (context: HookContext) => Promise<HookOutcome>

export interface HookRegistry {
  register(point: HookPoint, handler: HookHandler, source: string): () => void
  /** Runs handlers in registration order; first `block` wins. */
  run(context: HookContext): Promise<HookOutcome>
}

/** A loaded, instantiated extension. */
export interface Extension {
  readonly manifest: ExtensionManifest
  readonly tools?: readonly Tool[]
  readonly workflowActions?: readonly WorkflowAction[]
  readonly hooks?: ReadonlyArray<{ readonly point: HookPoint; readonly handler: HookHandler }>
}

/** Discovers and loads extensions from configured locations. */
export interface ExtensionProvider {
  readonly id: string
  discover(): Promise<readonly ExtensionManifest[]>
  load(id: string): Promise<Extension>
}
