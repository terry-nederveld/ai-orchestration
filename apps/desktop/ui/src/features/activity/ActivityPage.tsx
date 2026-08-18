/**
 * Work-centric landing page (ADR-0025): a single newest-first feed of runs
 * aggregated across every runtime connection, grouped by work item, with a
 * NEEDS YOU marker wherever a run is blocked on a human. Entries from an
 * unreachable runtime stay visible, dimmed and marked stale.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useConnections } from '../../api/connection'
import { useFederatedEvents } from '../../api/events'
import { useFederatedQuery } from '../../api/federation'
import { TERMINAL_RUN_STATES } from '../../api/types'
import { Badge, StateBadge } from '../../components/Badge'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Tabs } from '../../components/Tabs'
import { relativeTime } from '../../lib/format'
import { splitWorkRef } from '../../lib/workRef'
import styles from './ActivityPage.module.css'
import { type ActivityGroup, type ActivityRow, buildActivityGroups } from './activity'
import { JudgmentsPanel } from './JudgmentsPanel'

const POLL_MS = 30_000
const RELOAD_DEBOUNCE_MS = 500
const DOMAIN_LOOKUP_CAP = 20

export function ActivityPage(): JSX.Element {
  const [tab, setTab] = useState<'activity' | 'judgments'>('activity')
  const runsQuery = useFederatedQuery('runs', (c) => c.listRuns({ limit: 100 }), [], {
    pollMs: POLL_MS,
  })
  const waitsQuery = useFederatedQuery('waits', (c) => c.listWaits(), [], { pollMs: POLL_MS })
  const titles = useWorkItemTitles()

  // Live: any run/work/approval movement on any runtime reloads the feed,
  // debounced so event bursts collapse into one refetch.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queriesRef = useRef({ runs: runsQuery.reload, waits: waitsQuery.reload })
  queriesRef.current = { runs: runsQuery.reload, waits: waitsQuery.reload }
  useFederatedEvents((_connection, event) => {
    if (
      event.type === 'run.state.changed' ||
      event.type === 'work.updated' ||
      event.type === 'work.claimed' ||
      event.type === 'approval.requested' ||
      event.type === 'approval.resolved'
    ) {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
      reloadTimer.current = setTimeout(() => {
        queriesRef.current.runs()
        queriesRef.current.waits()
      }, RELOAD_DEBOUNCE_MS)
    }
  })
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    },
    [],
  )

  const groups = useMemo(
    () => buildActivityGroups(runsQuery.records, waitsQuery.records, titles),
    [runsQuery.records, waitsQuery.records, titles],
  )

  const unreachable = runsQuery.records.filter(
    (record) => record.error !== null && record.data === undefined,
  )

  const anyData = groups.length > 0

  return (
    <div>
      <Tabs
        items={[
          { key: 'activity', label: 'Activity' },
          { key: 'judgments', label: 'Judgments' },
        ]}
        active={tab}
        onChange={(key) => setTab(key as 'activity' | 'judgments')}
      />
      <div style={{ height: 'var(--space-5)' }} />

      {tab === 'judgments' ? (
        <JudgmentsPanel />
      ) : (
        <div className={styles.feed}>
          {unreachable.map((record) => (
            <div key={record.connection} className={styles.sourceNote}>
              {record.connection} is unreachable ({record.error}); nothing cached to show.
            </div>
          ))}

          {runsQuery.loading && !anyData ? (
            <Spinner />
          ) : !anyData ? (
            <EmptyState
              icon="✦"
              title="No activity yet"
              hint="Runs from every connected runtime appear here, newest first, grouped by work item."
            />
          ) : (
            groups.map((group) => <ActivityGroupView key={group.workItemId} group={group} />)
          )}
        </div>
      )}
    </div>
  )
}

function ActivityGroupView({ group }: { readonly group: ActivityGroup }): JSX.Element {
  const { externalId } = splitWorkRef(group.workItemId)
  return (
    <section className={styles.group}>
      <header className={styles.groupHeader}>
        <span className={styles.groupTitle}>{group.title ?? externalId}</span>
        <span className={styles.groupExternalId}>{group.workItemId}</span>
        <span className={styles.groupWorkflow}>{group.workflowNames.join(', ')}</span>
      </header>
      {group.rows.map((row) => (
        <ActivityRowView key={`${row.connection}:${row.run.id}`} row={row} />
      ))}
    </section>
  )
}

function ActivityRowView({ row }: { readonly row: ActivityRow }): JSX.Element {
  const navigate = useNavigate()
  const domainName = useDomainName(row)
  return (
    <button
      type="button"
      className={[styles.runRow, row.stale ? styles.stale : ''].filter(Boolean).join(' ')}
      onClick={() =>
        navigate(
          `/runs/${encodeURIComponent(row.run.id)}?conn=${encodeURIComponent(row.connection)}`,
        )
      }
    >
      <StateBadge state={row.run.state} />
      {domainName && <span className={styles.domainState}>{domainName}</span>}
      <Badge tone="neutral">{row.connection}</Badge>
      {row.stale && (
        <>
          <Badge tone="warning">stale</Badge>
          {row.lastUpdatedAt && (
            <span className={styles.domainState}>last seen {relativeTime(row.lastUpdatedAt)}</span>
          )}
        </>
      )}
      {row.openWaits > 0 && (
        <Badge tone="danger" className={styles.needsYou ?? ''}>
          NEEDS YOU{row.openWaits > 1 ? ` (${row.openWaits})` : ''}
        </Badge>
      )}
      <span className={styles.runId}>{row.run.id}</span>
      <span className={styles.rowTime}>{relativeTime(row.run.updatedAt)}</span>
    </button>
  )
}

/**
 * Best-effort work item titles per connection: each runtime's work sources
 * are listed and mapped `source:externalId` → title. Failures simply leave
 * the external id as the display name.
 */
function useWorkItemTitles(): ReadonlyMap<string, string> {
  const query = useFederatedQuery('work-item-titles', async (client) => {
    const entries: Array<readonly [string, string]> = []
    const status = await client.status()
    for (const source of status.workSources) {
      try {
        const items = await client.listWorkItems(source)
        for (const item of items) entries.push([`${source}:${item.externalId}`, item.title])
      } catch {
        // best-effort enrichment; skip sources that fail to list
      }
    }
    return entries
  })
  return useMemo(() => {
    const map = new Map<string, string>()
    for (const record of query.records) {
      for (const [key, title] of record.data ?? []) map.set(key, title)
    }
    return map
  }, [query.records])
}

// Shared, capped lookup of domain-state names for feed rows. Module-level so
// every row reuses one result per run instead of fetching per component.
const domainNameCache = new Map<string, string | null>()

/**
 * Best-effort domain state for a feed row: durable graph runs expose it via
 * GET /api/graph-runs/:id; v1 runs (404) simply show nothing.
 */
function useDomainName(row: ActivityRow): string | undefined {
  const { connections } = useConnections()
  const key = `${row.connection} ${row.run.id}`
  const cached = domainNameCache.get(key)
  const [name, setName] = useState<string | undefined>(cached ?? undefined)

  const terminal = TERMINAL_RUN_STATES.includes(row.run.state)
  const shouldFetch =
    cached === undefined && !row.stale && !terminal && domainNameCache.size < DOMAIN_LOOKUP_CAP

  useEffect(() => {
    if (!shouldFetch) return
    const client = connections.find(
      (connection) => connection.entry.name === row.connection,
    )?.client
    if (!client) return
    let cancelled = false
    client
      .getGraphRun(row.run.id)
      .then((view) => {
        const domainName = view?.state.domain.name ?? null
        domainNameCache.set(key, domainName)
        if (!cancelled && domainName) setName(domainName)
      })
      .catch(() => {
        domainNameCache.set(key, null)
      })
    return () => {
      cancelled = true
    }
  }, [shouldFetch, key, row.run.id, row.connection, connections])

  return name
}
