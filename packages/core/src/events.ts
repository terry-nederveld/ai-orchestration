/**
 * Orchestrator event model and event bus port.
 *
 * Everything meaningful emits a structured event; UI, persistence, and hooks
 * consume events instead of coupling to the runtime.
 */

import type { AgentEvent } from './agent.js'
import type { BudgetStatus } from './budget.js'
import type { EventId, RunId, SessionId } from './ids.js'
import type { RunState } from './run.js'

interface BaseEvent {
  readonly id: EventId
  readonly at: Date
  readonly runId?: RunId
}

export type OrchestratorEventPayload =
  | { readonly type: 'work.discovered'; readonly workItemId: string; readonly provider: string }
  | { readonly type: 'work.claimed'; readonly workItemId: string; readonly runId: RunId }
  | { readonly type: 'work.claim.rejected'; readonly workItemId: string; readonly reason: string }
  | { readonly type: 'work.updated'; readonly workItemId: string; readonly detail: string }
  | { readonly type: 'workspace.created'; readonly workspaceId: string; readonly path: string }
  | { readonly type: 'workspace.cleaned'; readonly workspaceId: string }
  | {
      readonly type: 'run.state.changed'
      readonly runId: RunId
      readonly from: RunState
      readonly to: RunState
      readonly reason?: string
    }
  | {
      readonly type: 'workflow.step.started'
      readonly runId: RunId
      readonly stepId: string
    }
  | {
      readonly type: 'workflow.step.completed'
      readonly runId: RunId
      readonly stepId: string
      readonly status: 'succeeded' | 'failed' | 'skipped'
    }
  | {
      readonly type: 'workflow.transitioned'
      readonly runId: RunId
      readonly transition: string
    }
  | {
      readonly type: 'model.request.started'
      readonly sessionId: SessionId
      readonly provider: string
      readonly model: string
    }
  | {
      readonly type: 'model.request.completed'
      readonly sessionId: SessionId
      readonly provider: string
      readonly model: string
      readonly durationMs: number
      readonly inputTokens: number
      readonly outputTokens: number
    }
  | { readonly type: 'agent'; readonly sessionId: SessionId; readonly event: AgentEvent }
  | { readonly type: 'validation.failed'; readonly runId: RunId; readonly detail: string }
  | { readonly type: 'delivery.pull_request.created'; readonly runId: RunId; readonly url: string }
  | { readonly type: 'budget.warning'; readonly status: BudgetStatus }
  | { readonly type: 'budget.exhausted'; readonly status: BudgetStatus }
  | {
      readonly type: 'approval.requested'
      readonly runId: RunId
      readonly requestId: string
      readonly description: string
    }
  | {
      readonly type: 'approval.resolved'
      readonly runId: RunId
      readonly requestId: string
      readonly approved: boolean
    }
  | { readonly type: 'error'; readonly scope: string; readonly message: string }
  | {
      readonly type: 'wait.opened'
      readonly runId: RunId
      readonly waitId: string
      readonly waitKind: string
      readonly nodeId: string
    }
  | {
      readonly type: 'wait.satisfied'
      readonly runId: RunId
      readonly waitId: string
      readonly waitKind: string
    }
  | {
      readonly type: 'human_input.requested'
      readonly runId: RunId
      readonly waitId: string
      readonly inputType: string
      readonly prompt: string
      readonly surface: string
    }
  | {
      readonly type: 'human_input.received'
      readonly runId: RunId
      readonly waitId: string
      readonly responder: string
      readonly channel: string
    }
  | {
      readonly type: 'checkpoint.created'
      readonly runId: RunId
      readonly checkpointId: string
      readonly strategy: string
      readonly summary: string
    }
  | {
      readonly type: 'spec.revised'
      readonly runId: RunId
      readonly revision: number
      readonly reason: string
    }
  | {
      readonly type: 'node.settled'
      readonly runId: RunId
      readonly nodeId: string
      readonly status: string
      readonly attempt: number
    }
  | {
      readonly type: 'transition.taken'
      readonly runId: RunId
      readonly transitionId: string
      readonly from: string
      readonly to: string
    }
  | {
      readonly type: 'domain_state.changed'
      readonly runId: RunId
      readonly state: string
    }
  | {
      readonly type: 'experiment.updated'
      readonly runId: RunId
      readonly experimentId: string
      readonly status: string
      readonly iteration: number
    }
  | {
      readonly type: 'judgment.requested'
      readonly runId: RunId
      readonly experimentId: string
    }
  | {
      readonly type: 'judgment.decided'
      readonly runId: RunId
      readonly experimentId: string
      readonly decision: string
    }
  | {
      readonly type: 'gate.evaluated'
      readonly runId: RunId
      readonly gateSet: string
      readonly passed: boolean
    }
  | {
      readonly type: 'routing.selection_required'
      readonly workItemId: string
      readonly candidates: readonly string[]
    }

export type OrchestratorEvent = BaseEvent & OrchestratorEventPayload
export type OrchestratorEventType = OrchestratorEventPayload['type']

export type EventHandler = (event: OrchestratorEvent) => void
export type Unsubscribe = () => void

export interface EventFilter {
  readonly types?: readonly OrchestratorEventType[]
  readonly runId?: RunId
}

export interface EventBus {
  publish(event: OrchestratorEvent): void
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe
}
