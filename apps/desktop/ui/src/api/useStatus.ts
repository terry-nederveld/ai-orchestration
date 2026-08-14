import { useEffect, useState } from 'react'
import { useConnection } from './connection'
import type { ServiceStatus } from './types'

const POLL_MS = 15_000

/** Polls `/api/status`; cheap and used for the header version/active-runs display. */
export function useStatus(): {
  readonly status: ServiceStatus | null
  readonly error: string | null
} {
  const { client, status: connectionStatus } = useConnection()
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client || connectionStatus !== 'connected') return
    let cancelled = false
    const load = () => {
      client
        .status()
        .then((next) => {
          if (!cancelled) {
            setStatus(next)
            setError(null)
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const interval = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [client, connectionStatus])

  return { status, error }
}
