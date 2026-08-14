/**
 * Agent contracts.
 *
 * Two distinct concepts:
 *  - AgentRuntime: the native loop driving a ModelProvider with tools.
 *  - AgentProvider: an external coding-agent runtime (Claude Code, Codex,
 *    Copilot, or the native runtime wrapped) that owns its own loop.
 *
 * Both produce the same observable event stream and terminal outcomes so the
 * orchestrator treats them uniformly.
 */

import type { TokenUsage, UsageRecord } from './budget.js'
import type { CapabilitySet, ProviderAvailability, ProviderInfo } from './capabilities.js'
import type { RunId, SessionId } from './ids.js'
import type { Workspace } from './workspace.js'

/** Explicit terminal outcomes. Text output alone never implies completion. */
export type AgentOutcome =
  | 'GOAL_COMPLETED'
  | 'GOAL_BLOCKED'
  | 'BUDGET_EXHAUSTED'
  | 'POLICY_BLOCKED'
  | 'HUMAN_INPUT_REQUIRED'
  | 'FATAL_FAILURE'
  | 'CANCELLED'

export interface AgentGoal {
  /** What done means, expressed declaratively. */
  readonly goal: string
  /** Extra grounding context (work item body, plan output, review findings). */
  readonly context?: string
  /** Role identifier from configuration (planner, coder, reviewer, …). */
  readonly role?: string
}

export interface AgentRunRequest {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly goal: AgentGoal
  readonly workspace?: Workspace
  /** Model routing selection already resolved by the orchestrator. */
  readonly model?: string
  readonly systemPrompt?: string
  readonly toolNames?: readonly string[]
  readonly maxTurns?: number
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

export interface AgentResult {
  readonly outcome: AgentOutcome
  /** Agent's final report: what was done, or why it is blocked. */
  readonly summary: string
  readonly usage: UsageRecord
  /** Provider session id enabling resume, when supported. */
  readonly providerSessionId?: string
}

/** Structured events emitted during an agent run. */
export type AgentEvent =
  | { readonly type: 'agent.started'; readonly sessionId: SessionId }
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
  | { readonly type: 'agent.subagent.started'; readonly childSessionId: SessionId }
  | {
      readonly type: 'agent.subagent.completed'
      readonly childSessionId: SessionId
      readonly outcome: AgentOutcome
    }
  | { readonly type: 'agent.waiting.human'; readonly reason: string }
  | { readonly type: 'agent.usage'; readonly usage: TokenUsage; readonly model: string }
  | { readonly type: 'agent.completed'; readonly result: AgentResult }

/** Handle to an in-flight agent execution. */
export interface AgentRunHandle {
  readonly sessionId: SessionId
  /** Structured event stream; ends after `agent.completed`. */
  events(): AsyncIterable<AgentEvent>
  /** Resolves with the terminal result (also carried by the last event). */
  result(): Promise<AgentResult>
  cancel(reason?: string): Promise<void>
}

/** An external coding-agent integration. */
export interface AgentProvider {
  readonly info: ProviderInfo
  capabilities(): CapabilitySet
  detect(): Promise<ProviderAvailability>
  start(request: AgentRunRequest): Promise<AgentRunHandle>
  /** Resume a previous provider session, when supported. */
  resume?(providerSessionId: string, request: AgentRunRequest): Promise<AgentRunHandle>
}

/**
 * The native runtime satisfies the same operational contract as an external
 * agent provider; the orchestrator depends only on this shape.
 */
export type AgentRuntime = Pick<AgentProvider, 'start'> & {
  resume?(providerSessionId: string, request: AgentRunRequest): Promise<AgentRunHandle>
}
