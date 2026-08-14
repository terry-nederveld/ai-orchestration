import type { ReactNode } from 'react'
import type { AgentEvent, OrchestratorEvent } from '../api/types'

/** Human-readable one-liner for an orchestrator event, used in tickers and logs. */
export function describeEvent(event: OrchestratorEvent): ReactNode {
  switch (event.type) {
    case 'work.discovered':
      return (
        <>
          Discovered <strong>{event.workItemId}</strong> via {event.provider}
        </>
      )
    case 'work.claimed':
      return (
        <>
          Claimed <strong>{event.workItemId}</strong> for run {shortId(event.runId)}
        </>
      )
    case 'work.claim.rejected':
      return (
        <>
          Claim rejected for <strong>{event.workItemId}</strong>: {event.reason}
        </>
      )
    case 'work.updated':
      return (
        <>
          Updated <strong>{event.workItemId}</strong>: {event.detail}
        </>
      )
    case 'workspace.created':
      return (
        <>
          Workspace <strong>{event.workspaceId}</strong> created at {event.path}
        </>
      )
    case 'workspace.cleaned':
      return (
        <>
          Workspace <strong>{event.workspaceId}</strong> cleaned up
        </>
      )
    case 'run.state.changed':
      return (
        <>
          Run {shortId(event.runId)}: <strong>{event.from}</strong> → <strong>{event.to}</strong>
          {event.reason ? ` (${event.reason})` : ''}
        </>
      )
    case 'workflow.step.started':
      return (
        <>
          Step <strong>{event.stepId}</strong> started on run {shortId(event.runId)}
        </>
      )
    case 'workflow.step.completed':
      return (
        <>
          Step <strong>{event.stepId}</strong> {event.status} on run {shortId(event.runId)}
        </>
      )
    case 'workflow.transitioned':
      return (
        <>
          Run {shortId(event.runId)} transitioned: <strong>{event.transition}</strong>
        </>
      )
    case 'model.request.started':
      return (
        <>
          Model request started: <strong>{event.model}</strong> ({event.provider})
        </>
      )
    case 'model.request.completed':
      return (
        <>
          Model request completed: <strong>{event.model}</strong> ·{' '}
          {event.inputTokens + event.outputTokens} tokens · {event.durationMs}ms
        </>
      )
    case 'agent':
      return describeAgentEvent(event.event, event.sessionId)
    case 'validation.failed':
      return (
        <>
          Validation failed on run {shortId(event.runId)}: {event.detail}
        </>
      )
    case 'delivery.pull_request.created':
      return (
        <>
          Pull request opened for run {shortId(event.runId)}: {event.url}
        </>
      )
    case 'budget.warning':
      return <>Budget warning ({event.status.budgetId})</>
    case 'budget.exhausted':
      return <>Budget exhausted ({event.status.budgetId})</>
    case 'approval.requested':
      return (
        <>
          Approval requested on run {shortId(event.runId)}: {event.description}
        </>
      )
    case 'approval.resolved':
      return (
        <>
          Approval {event.approved ? 'granted' : 'denied'} on run {shortId(event.runId)}
        </>
      )
    case 'error':
      return (
        <>
          Error in {event.scope}: {event.message}
        </>
      )
    default:
      return null
  }
}

function describeAgentEvent(agentEvent: AgentEvent, sessionId: string): ReactNode {
  switch (agentEvent.type) {
    case 'agent.started':
      return (
        <>
          Agent session <strong>{shortId(sessionId)}</strong> started
        </>
      )
    case 'agent.tool.started':
      return (
        <>
          Tool call: <strong>{agentEvent.toolName}</strong>
        </>
      )
    case 'agent.tool.completed':
      return (
        <>
          Tool {agentEvent.toolName} {agentEvent.isError ? 'failed' : 'completed'}
        </>
      )
    case 'agent.waiting.human':
      return <>Waiting on a human: {agentEvent.reason}</>
    case 'agent.completed':
      return <>Agent session {shortId(sessionId)} completed</>
    default:
      return (
        <>
          {agentEvent.type} ({shortId(sessionId)})
        </>
      )
  }
}

function shortId(id: string | undefined): string {
  if (!id) return '—'
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}
