/**
 * SSE subscription to the daemon's live event stream. Auto-reconnects with
 * exponential backoff (capped) when the connection drops.
 */
import { useEffect, useRef, useState } from 'react'
import { useConnections, useRuntimeConnection } from './connection'
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

/**
 * Live event stream for one runtime — the named connection, or the primary
 * one when omitted — optionally scoped to a single run.
 */
export function useEventStream(
  runId?: string,
  options?: {
    readonly maxEvents?: number
    readonly onEvent?: (event: OrchestratorEvent) => void
    /** Stream from this named connection instead of the primary one. */
    readonly connection?: string
  },
): { readonly events: readonly OrchestratorEvent[]; readonly connected: boolean } {
  const runtime = useRuntimeConnection(options?.connection)
  const client = runtime?.health === 'connected' ? runtime.client : null
  const [events, setEvents] = useState<readonly OrchestratorEvent[]>([])
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(options?.onEvent)
  onEventRef.current = options?.onEvent
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS

  useEffect(() => {
    // jsdom has no EventSource; tests exercise pages without live streams.
    if (!client || typeof EventSource === 'undefined') return
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
  }, [client, runId, maxEvents])

  return { events, connected }
}

/**
 * One SSE subscription per connected runtime (ADR-0025): each stream backs
 * off independently and a dropped runtime never affects the others. Events
 * are delivered to `onEvent` tagged with their source connection name.
 */
export function useFederatedEvents(
  onEvent: (connection: string, event: OrchestratorEvent) => void,
): void {
  const { connections } = useConnections()
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const signature = connections
    .map(
      (connection) => `${connection.entry.name}:${connection.health}:${connection.client.baseUrl}`,
    )
    .join('|')
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands in for the connections array.
  useEffect(() => {
    // jsdom has no EventSource; tests exercise pages without live streams.
    if (typeof EventSource === 'undefined') return
    const unsubscribers = connectionsRef.current
      .filter((connection) => connection.health === 'connected')
      .map((connection) =>
        subscribeToEvents(
          connection.client.eventsUrl(),
          (event) => onEventRef.current(connection.entry.name, event),
          () => {},
        ),
      )
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [signature])
}
