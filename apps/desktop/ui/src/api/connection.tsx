/**
 * Federated connection registry (ADR-0025). The app holds N named runtime
 * connections — the local sidecar daemon plus any number of remote runtimes
 * — each with its own token and independent availability. The list persists
 * in localStorage; per-connection health is probed via `/api/status` on an
 * interval so an unreachable runtime degrades to stale data without ever
 * blocking the others.
 *
 * First-run resolution keeps the v1 fast path: an injected
 * `window.__OVERTURE_DAEMON__` handle, `#port=NNNN&token=XXXX` hash params,
 * or a legacy stored single connection each become a connection named
 * "Local".
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { ApiClient, type DaemonConnection } from './client'

const STORAGE_KEY = 'overture.connections'
const LEGACY_STORAGE_KEY = 'overture.connection'
const HEALTH_POLL_MS = 15_000

export type ConnectionKind = 'local' | 'remote'

export interface ConnectionEntry {
  readonly name: string
  readonly host: string
  readonly port: number
  readonly token: string
  readonly kind: ConnectionKind
}

export type ConnectionHealth = 'connecting' | 'connected' | 'unreachable'

/** A configured runtime connection plus its live health. */
export interface RuntimeConnection {
  readonly entry: ConnectionEntry
  readonly client: ApiClient
  readonly health: ConnectionHealth
  readonly error: string | null
  /** ISO time of the last successful response from this runtime. */
  readonly lastSeenAt: string | null
}

export interface ConnectionsState {
  readonly connections: readonly RuntimeConnection[]
  /** Adds (or replaces, by name) a connection. */
  addConnection(entry: ConnectionEntry): void
  removeConnection(name: string): void
  /** Re-probes every connection's health immediately. */
  refresh(): void
}

export function entryBaseUrl(entry: ConnectionEntry): string {
  if (entry.host.includes('://')) return `${entry.host.replace(/\/$/, '')}:${entry.port}`
  const scheme = entry.kind === 'remote' ? 'https' : 'http'
  return `${scheme}://${entry.host}:${entry.port}`
}

function isEntry(value: unknown): value is ConnectionEntry {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ConnectionEntry>
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.host === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.token === 'string' &&
    (candidate.kind === 'local' || candidate.kind === 'remote')
  )
}

/** Exported for unit testing; not meant to be called outside this module. */
export function readStoredEntries(): readonly ConnectionEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

function persistEntries(entries: readonly ConnectionEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // storage unavailable (e.g. private mode); connections still work this tab
  }
}

function legacyToEntry(connection: DaemonConnection): ConnectionEntry | undefined {
  try {
    const url = new URL(connection.baseUrl)
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    const host = url.hostname
    const kind: ConnectionKind = host === '127.0.0.1' || host === 'localhost' ? 'local' : 'remote'
    return { name: 'Local', host, port, token: connection.token, kind }
  } catch {
    return undefined
  }
}

/** Exported for unit testing; not meant to be called outside this module. */
export function readHashConnection(): DaemonConnection | undefined {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return undefined
  const params = new URLSearchParams(hash)
  const port = params.get('port')
  const token = params.get('token')
  if (!port || !token) return undefined
  return { baseUrl: `http://127.0.0.1:${port}`, token }
}

/** Exported for unit testing; not meant to be called outside this module. */
export function readLegacyStoredConnection(): DaemonConnection | undefined {
  try {
    const raw = sessionStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<DaemonConnection>
    if (typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string') {
      return { baseUrl: parsed.baseUrl, token: parsed.token }
    }
  } catch {
    // ignore malformed storage
  }
  return undefined
}

/**
 * Initial connection list: the stored registry, merged with whatever the v1
 * single-connection fast path resolves (injected handle, hash params, or the
 * legacy sessionStorage entry) so `overture daemon --open` keeps working.
 */
export function resolveInitialEntries(): readonly ConnectionEntry[] {
  const stored = readStoredEntries()
  const legacy = window.__OVERTURE_DAEMON__
    ? { baseUrl: window.__OVERTURE_DAEMON__.baseUrl, token: window.__OVERTURE_DAEMON__.token }
    : (readHashConnection() ?? readLegacyStoredConnection())
  if (!legacy) return stored
  const entry = legacyToEntry(legacy)
  if (!entry) return stored
  const alreadyKnown = stored.some((candidate) => entryBaseUrl(candidate) === entryBaseUrl(entry))
  if (alreadyKnown) return stored
  const name = stored.some((candidate) => candidate.name === entry.name)
    ? `Local (${entry.port})`
    : entry.name
  return [{ ...entry, name }, ...stored]
}

interface HealthRecord {
  readonly health: ConnectionHealth
  readonly error: string | null
  readonly lastSeenAt: string | null
}

const ConnectionsContext = createContext<ConnectionsState | undefined>(undefined)

export interface ConnectionProviderProps {
  readonly children: ReactNode
  /** Test hook: seed the registry instead of resolving from storage. */
  readonly initialEntries?: readonly ConnectionEntry[] | undefined
  readonly pollMs?: number
}

export function ConnectionProvider({
  children,
  initialEntries,
  pollMs = HEALTH_POLL_MS,
}: ConnectionProviderProps): JSX.Element {
  const [entries, setEntries] = useState<readonly ConnectionEntry[]>(
    () => initialEntries ?? resolveInitialEntries(),
  )
  const [healthByName, setHealthByName] = useState<Readonly<Record<string, HealthRecord>>>({})
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    persistEntries(entries)
  }, [entries])

  const clients = useMemo(() => {
    const map = new Map<string, ApiClient>()
    for (const entry of entries) {
      map.set(entry.name, new ApiClient({ baseUrl: entryBaseUrl(entry), token: entry.token }))
    }
    return map
  }, [entries])

  // generation isn't read below; it's a synthetic trigger so refresh()
  // forces an immediate re-probe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false
    const probe = () => {
      for (const entry of entries) {
        const client = clients.get(entry.name)
        if (!client) continue
        client
          .status()
          .then(() => {
            if (cancelled) return
            setHealthByName((prev) => ({
              ...prev,
              [entry.name]: {
                health: 'connected',
                error: null,
                lastSeenAt: new Date().toISOString(),
              },
            }))
          })
          .catch((err: unknown) => {
            if (cancelled) return
            setHealthByName((prev) => ({
              ...prev,
              [entry.name]: {
                health: 'unreachable',
                error: err instanceof Error ? err.message : String(err),
                lastSeenAt: prev[entry.name]?.lastSeenAt ?? null,
              },
            }))
          })
      }
    }
    probe()
    const interval = setInterval(probe, pollMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [entries, clients, generation, pollMs])

  const addConnection = useCallback((entry: ConnectionEntry) => {
    setEntries((prev) => [...prev.filter((candidate) => candidate.name !== entry.name), entry])
    // Force the new entry's health record back to 'connecting'.
    setHealthByName((prev) => {
      const { [entry.name]: _dropped, ...rest } = prev
      return rest
    })
  }, [])

  const removeConnection = useCallback((name: string) => {
    setEntries((prev) => prev.filter((candidate) => candidate.name !== name))
    setHealthByName((prev) => {
      const { [name]: _dropped, ...rest } = prev
      return rest
    })
  }, [])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  const connections = useMemo<readonly RuntimeConnection[]>(
    () =>
      entries.flatMap((entry) => {
        const client = clients.get(entry.name)
        if (!client) return []
        const record = healthByName[entry.name]
        return [
          {
            entry,
            client,
            health: record?.health ?? 'connecting',
            error: record?.error ?? null,
            lastSeenAt: record?.lastSeenAt ?? null,
          },
        ]
      }),
    [entries, clients, healthByName],
  )

  const value = useMemo<ConnectionsState>(
    () => ({ connections, addConnection, removeConnection, refresh }),
    [connections, addConnection, removeConnection, refresh],
  )

  return <ConnectionsContext.Provider value={value}>{children}</ConnectionsContext.Provider>
}

export function useConnections(): ConnectionsState {
  const context = useContext(ConnectionsContext)
  if (!context) throw new Error('useConnections must be used within a ConnectionProvider')
  return context
}

/** Named connection, or the primary (first healthy) one when omitted. */
export function useRuntimeConnection(name?: string): RuntimeConnection | undefined {
  const { connections } = useConnections()
  if (name) return connections.find((connection) => connection.entry.name === name)
  return connections.find((connection) => connection.health === 'connected') ?? connections[0]
}

// ----- single-connection compatibility -------------------------------------

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionState {
  readonly status: ConnectionStatus
  readonly client: ApiClient | null
  readonly connection: DaemonConnection | null
  readonly error: string | null
}

/**
 * v1 single-connection view over the federation registry: the primary
 * connection is the first healthy one. Existing pages keep working; new
 * federation-aware code should use `useConnections` instead.
 */
export function useConnection(): ConnectionState {
  const { connections } = useConnections()
  const primary =
    connections.find((connection) => connection.health === 'connected') ?? connections[0]
  if (!primary) return { status: 'disconnected', client: null, connection: null, error: null }
  const status: ConnectionStatus =
    primary.health === 'connected'
      ? 'connected'
      : primary.health === 'connecting'
        ? 'connecting'
        : 'error'
  return {
    status,
    client: primary.client,
    connection: { baseUrl: primary.client.baseUrl, token: primary.client.token },
    error: primary.error,
  }
}
