/**
 * "Needs you": everything blocked on a human, aggregated across all runtime
 * connections — durable waits with their typed response forms, plus policy
 * approvals. Entries from an unreachable runtime stay visible (stale, dimmed)
 * with actions disabled; they never hide the reachable runtimes' work.
 */
import { useState } from 'react'
import type { ApiClient } from '../../api/client'
import { useConnections } from '../../api/connection'
import { useFederatedQuery } from '../../api/federation'
import type { PendingApproval, WaitCondition } from '../../api/types'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { useToast } from '../../components/Toast'
import { relativeTime } from '../../lib/format'
import styles from './ApprovalsPage.module.css'
import { WaitResponseForm } from './WaitResponseForm'

const POLL_MS = 30_000

export function ApprovalsPage(): JSX.Element {
  const { connections } = useConnections()
  const { push } = useToast()
  const waitsQuery = useFederatedQuery('waits', (c) => c.listWaits(), [], { pollMs: POLL_MS })
  const approvalsQuery = useFederatedQuery('approvals', (c) => c.listApprovals(), [], {
    pollMs: POLL_MS,
  })
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const clientFor = (name: string) =>
    connections.find((connection) => connection.entry.name === name)?.client

  const waitEntries = waitsQuery.records.flatMap((record) =>
    (record.data ?? []).map((wait) => ({ record, wait })),
  )
  const approvalEntries = approvalsQuery.records.flatMap((record) =>
    (record.data ?? []).map((approval) => ({ record, approval })),
  )

  const resolveApproval = async (connection: string, id: string, approved: boolean) => {
    const client = clientFor(connection)
    if (!client) return
    setResolvingId(id)
    try {
      const result = await client.resolveApproval(id, approved)
      if (result.resolved) {
        push(approved ? 'Approved' : 'Denied', 'success')
        approvalsQuery.reload()
      } else {
        push('This request already resolved or timed out', 'error')
      }
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to resolve approval', 'error')
    } finally {
      setResolvingId(null)
    }
  }

  const loading =
    (waitsQuery.loading && waitEntries.length === 0) ||
    (approvalsQuery.loading && approvalEntries.length === 0)

  return (
    <div className={styles.stack}>
      <Card
        title="Waiting on you"
        subtitle={waitEntries.length > 0 ? `${waitEntries.length} open` : undefined}
      >
        {loading ? (
          <Spinner />
        ) : waitEntries.length === 0 ? (
          <EmptyState
            icon="✋"
            title="Nothing waiting on you"
            hint="Runs that pause for human input, approvals, or judgment show up here until answered."
          />
        ) : (
          <div className={styles.waitList}>
            {waitEntries.map(({ record, wait }) => (
              <WaitEntry
                key={`${record.connection}:${wait.id}`}
                wait={wait}
                connection={record.connection}
                stale={record.stale}
                lastUpdatedAt={record.lastUpdatedAt}
                client={clientFor(record.connection)}
                onResolved={waitsQuery.reload}
              />
            ))}
          </div>
        )}
        {waitsQuery.records
          .filter((record) => record.error && (record.data ?? []).length === 0)
          .map((record) => (
            <div key={record.connection} className={styles.sourceError}>
              {record.connection}: {record.error}
            </div>
          ))}
      </Card>

      <Card
        title="Policy approvals"
        subtitle={approvalEntries.length > 0 ? `${approvalEntries.length} waiting` : undefined}
        flush
      >
        {approvalEntries.length === 0 ? (
          <EmptyState
            icon="✓"
            title="No policy approvals pending"
            hint="When policy marks an operation as 'ask', or a workflow hits an approval step, it shows up here until approved or denied."
          />
        ) : (
          <Table
            rows={approvalEntries}
            rowKey={({ record, approval }) => `${record.connection}:${approval.id}`}
            columns={[
              {
                key: 'capability',
                header: 'Capability',
                render: ({ approval }: ApprovalRow) => (
                  <span className="mono">{approval.request.capability}</span>
                ),
              },
              {
                key: 'target',
                header: 'Target',
                render: ({ approval }: ApprovalRow) => approval.request.target ?? '—',
              },
              {
                key: 'connection',
                header: 'Connection',
                render: ({ record }: ApprovalRow) => (
                  <>
                    <Badge tone="neutral">{record.connection}</Badge>{' '}
                    {record.stale && <Badge tone="warning">stale</Badge>}
                  </>
                ),
              },
              {
                key: 'decision',
                header: 'Policy',
                render: ({ approval }: ApprovalRow) => (
                  <Badge tone={approval.decision.effect === 'deny' ? 'danger' : 'warning'}>
                    {approval.decision.effect}
                  </Badge>
                ),
              },
              {
                key: 'age',
                header: 'Requested',
                render: ({ approval }: ApprovalRow) => relativeTime(approval.requestedAt),
              },
              {
                key: 'actions',
                header: '',
                render: ({ record, approval }: ApprovalRow) => (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={resolvingId === approval.id}
                      disabled={record.stale}
                      onClick={() => void resolveApproval(record.connection, approval.id, true)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={resolvingId === approval.id}
                      disabled={record.stale}
                      onClick={() => void resolveApproval(record.connection, approval.id, false)}
                    >
                      Deny
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  )
}

interface ApprovalRow {
  readonly record: { readonly connection: string; readonly stale: boolean }
  readonly approval: PendingApproval
}

function WaitEntry({
  wait,
  connection,
  stale,
  lastUpdatedAt,
  client,
  onResolved,
}: {
  readonly wait: WaitCondition
  readonly connection: string
  readonly stale: boolean
  readonly lastUpdatedAt: string | null
  readonly client: ApiClient | undefined
  readonly onResolved: () => void
}): JSX.Element {
  return (
    <div className={[styles.waitCard, stale ? styles.stale : ''].filter(Boolean).join(' ')}>
      <div className={styles.waitHeader}>
        <Badge tone="neutral">{connection}</Badge>
        {stale && (
          <>
            <Badge tone="warning">stale</Badge>
            {lastUpdatedAt && <span>last seen {relativeTime(lastUpdatedAt)}</span>}
          </>
        )}
        <Badge tone="accent">{wait.kind}</Badge>
        <span className={styles.waitRun}>{wait.runId}</span>
        <span>· node {wait.nodeId}</span>
        <span>· opened {relativeTime(wait.createdAt)}</span>
      </div>
      {client ? (
        <WaitResponseForm wait={wait} client={client} disabled={stale} onResolved={onResolved} />
      ) : null}
    </div>
  )
}
