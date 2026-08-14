/**
 * Resolves how to reach the local Overture daemon and exposes an ApiClient
 * to the rest of the app. Resolution order:
 *   1. `window.__OVERTURE_DAEMON__` — injected by the future Tauri shell.
 *   2. URL hash params `#port=NNNN&token=XXXX` — set by `overture daemon --open`.
 *   3. sessionStorage — remembered from a manual connect form.
 * When none resolve, the app renders a disconnected state with a connect
 * form and instructions for starting the daemon.
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

const STORAGE_KEY = 'overture.connection'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionState {
  readonly status: ConnectionStatus
  readonly client: ApiClient | null
  readonly connection: DaemonConnection | null
  readonly error: string | null
  connect(baseUrl: string, token: string): void
  disconnect(): void
}

const ConnectionContext = createContext<ConnectionState | undefined>(undefined)

/** Exported for unit testing; not meant to be called outside this module. */
export function readStoredConnection(): DaemonConnection | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
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

export function resolveInitialConnection(): DaemonConnection | undefined {
  if (window.__OVERTURE_DAEMON__) {
    const { baseUrl, token } = window.__OVERTURE_DAEMON__
    return { baseUrl, token }
  }
  return readHashConnection() ?? readStoredConnection()
}

export function ConnectionProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [connection, setConnection] = useState<DaemonConnection | null>(
    () => resolveInitialConnection() ?? null,
  )
  const [status, setStatus] = useState<ConnectionStatus>(connection ? 'connecting' : 'disconnected')
  const [error, setError] = useState<string | null>(null)

  const client = useMemo(() => (connection ? new ApiClient(connection) : null), [connection])

  useEffect(() => {
    if (!client) {
      setStatus('disconnected')
      return
    }
    let cancelled = false
    setStatus('connecting')
    client
      .status()
      .then(() => {
        if (!cancelled) {
          setStatus('connected')
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus('error')
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const connect = useCallback((baseUrl: string, token: string) => {
    const next: DaemonConnection = { baseUrl: baseUrl.replace(/\/$/, ''), token }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // sessionStorage unavailable (e.g. private mode); connection still works this tab
    }
    setConnection(next)
  }, [])

  const disconnect = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setConnection(null)
    setError(null)
  }, [])

  const value: ConnectionState = { status, client, connection, error, connect, disconnect }

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection(): ConnectionState {
  const context = useContext(ConnectionContext)
  if (!context) throw new Error('useConnection must be used within a ConnectionProvider')
  return context
}
