/**
 * SSE subscription to the daemon's live event stream. Auto-reconnects with
 * exponential backoff (capped) when the connection drops.
 */
import { useEffect, useRef, useState } from 'react'
import { useConnection } from './connection'
import type { OrchestratorEvent, OrchestratorEventType } from './types'

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15_000

export type EventSourceFactory = (url: string) => EventSource

/** Low-level subscription, factored out so it is trivially mockable in tests. */
export function subscribeToEvents(
  url: string,
  onEvent: (event: OrchestratorEvent) => void,
  onConnectionChange: (connected: boolean) => void,
  createEventSource: EventSourceFactory = (u) => new EventSource(u),
): () => void {
  let closed = false
  let backoff = INITIAL_BACKOFF_MS
  let source: EventSource | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const eventTypes: readonly OrchestratorEventType[] = [
    'work.discovered',
    'work.claimed',
    'work.claim.rejected',
    'work.updated',
    'workspace.created',
    'workspace.cleaned',
    'run.state.changed',
    'workflow.step.started',
    'workflow.step.completed',
    'workflow.transitioned',
    'model.request.started',
    'model.request.completed',
    'agent',
    'validation.failed',
    'delivery.pull_request.created',
    'budget.warning',
    'budget.exhausted',
    'approval.requested',
    'approval.resolved',
    'error',
  ]

  const connect = () => {
    if (closed) return
    source = createEventSource(url)
    source.onopen = () => {
      backoff = INITIAL_BACKOFF_MS
      onConnectionChange(true)
    }
    const handle = (raw: MessageEvent) => {
      try {
        onEvent(JSON.parse(raw.data) as OrchestratorEvent)
      } catch {
        // ignore malformed frames
      }
    }
    for (const type of eventTypes) source.addEventListener(type, handle as EventListener)
    source.onerror = () => {
      onConnectionChange(false)
      source?.close()
      if (closed) return
      retryTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  connect()

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    source?.close()
  }
}

const DEFAULT_MAX_EVENTS = 200

/** Live event stream for the whole daemon, or scoped to a single run. */
export function useEventStream(
  runId?: string,
  options?: { readonly maxEvents?: number; readonly onEvent?: (event: OrchestratorEvent) => void },
): { readonly events: readonly OrchestratorEvent[]; readonly connected: boolean } {
  const { client, status } = useConnection()
  const [events, setEvents] = useState<readonly OrchestratorEvent[]>([])
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(options?.onEvent)
  onEventRef.current = options?.onEvent
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS

  useEffect(() => {
    if (status !== 'connected' || !client) return
    setEvents([])
    const url = client.eventsUrl(runId)
    const unsubscribe = subscribeToEvents(
      url,
      (event) => {
        onEventRef.current?.(event)
        setEvents((prev) => {
          const next = [...prev, event]
          return next.length > maxEvents ? next.slice(next.length - maxEvents) : next
        })
      },
      setConnected,
    )
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, status, runId, maxEvents])

  return { events, connected }
}
