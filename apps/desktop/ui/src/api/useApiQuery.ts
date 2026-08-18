import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from './client'
import { useConnection } from './connection'

export interface ApiQueryResult<T> {
  readonly data: T | undefined
  readonly error: string | null
  readonly loading: boolean
  readonly reload: () => void
}

/**
 * Fetches data from an explicit client (a specific runtime connection) and
 * re-fetches whenever `deps` change or `reload()` is called. Pass null while
 * no client is ready; the query stays in its loading state.
 */
export function useClientQuery<T>(
  client: ApiClient | null,
  fetcher: (client: ApiClient) => Promise<T>,
  deps: readonly unknown[] = [],
): ApiQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const reload = useCallback(() => setGeneration((g) => g + 1), [])

  // generation isn't read in the body below; it's a synthetic trigger so
  // reload() forces this effect to re-run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client) return
    let cancelled = false
    setLoading(true)
    fetcherRef
      .current(client)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, generation, ...deps])

  return { data, error, loading, reload }
}

/**
 * Fetches data from the primary connected daemon. Shared by every feature
 * page so loading / error / empty handling is consistent app-wide.
 */
export function useApiQuery<T>(
  fetcher: (client: ApiClient) => Promise<T>,
  deps: readonly unknown[] = [],
): ApiQueryResult<T> {
  const { client, status: connectionStatus } = useConnection()
  return useClientQuery(connectionStatus === 'connected' ? client : null, fetcher, deps)
}
