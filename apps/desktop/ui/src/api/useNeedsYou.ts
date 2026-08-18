import { useFederatedQuery } from './federation'

const POLL_MS = 30_000

/**
 * Aggregate count of everything blocked on a human — open durable waits
 * plus pending policy approvals — across every runtime connection. Stale
 * (last-known) entries from unreachable runtimes are counted: they still
 * exist, the runtime is just unreachable right now.
 */
export function useNeedsYouCount(): number {
  const waits = useFederatedQuery('waits', (c) => c.listWaits(), [], { pollMs: POLL_MS })
  const approvals = useFederatedQuery('approvals', (c) => c.listApprovals(), [], {
    pollMs: POLL_MS,
  })
  const openWaits = waits.records.reduce(
    (sum, record) => sum + (record.data ?? []).filter((wait) => wait.status === 'open').length,
    0,
  )
  const pendingApprovals = approvals.records.reduce(
    (sum, record) => sum + (record.data ?? []).length,
    0,
  )
  return openWaits + pendingApprovals
}
