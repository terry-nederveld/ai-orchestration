import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useConnection } from '../../api/connection'
import { useEventStream } from '../../api/events'
import type { Run } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge, StateBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { StatTile } from '../../components/StatTile'
import { Table } from '../../components/Table'
import { useToast } from '../../components/Toast'
import { describeEvent } from '../../lib/describeEvent'
import { relativeTime } from '../../lib/format'
import styles from './Dashboard.module.css'

const ACTIVE_STATES = [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'WAITING_FOR_TOOL',
  'WAITING_FOR_SUBAGENT',
  'WAITING_FOR_HUMAN',
  'VERIFYING',
]

export function Dashboard(): JSX.Element {
  const navigate = useNavigate()
  const { client } = useConnection()
  const { push } = useToast()
  const runsQuery = useApiQuery((c) => c.listRuns({ limit: 100 }))
  const providersQuery = useApiQuery((c) => c.listProviders())
  const approvalsQuery = useApiQuery((c) => c.listApprovals())
  const { events } = useEventStream(undefined, { maxEvents: 20 })
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const handleApproval = async (id: string, approved: boolean) => {
    if (!client) return
    setResolvingId(id)
    try {
      await client.resolveApproval(id, approved)
      push(approved ? 'Approved' : 'Denied', 'success')
      approvalsQuery.reload()
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to resolve approval', 'error')
    } finally {
      setResolvingId(null)
    }
  }

  const runs = runsQuery.data ?? []
  const queued = runs.filter((r) => r.state === 'QUEUED').length
  const blocked = runs.filter((r) => r.state === 'BLOCKED').length
  const active = runs.filter((r) => ACTIVE_STATES.includes(r.state)).length
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  const failuresLast24h = runs.filter(
    (r) => r.state === 'FAILED' && new Date(r.updatedAt).getTime() >= dayAgo,
  ).length

  const providers = providersQuery.data ?? []
  const availableProviders = providers.filter((p) => p.availability.available).length

  const approvals = approvalsQuery.data ?? []

  return (
    <div>
      <div className={styles.grid}>
        <StatTile label="Active runs" value={active} tone={active > 0 ? 'accent' : 'default'} />
        <StatTile label="Queued" value={queued} />
        <StatTile
          label="Blocked"
          value={blocked}
          tone={blocked > 0 ? 'warning' : 'default'}
          sub={blocked > 0 ? 'needs a decision' : undefined}
        />
        <StatTile
          label="Failures (24h)"
          value={failuresLast24h}
          tone={failuresLast24h > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Providers available"
          value={`${availableProviders}/${providers.length}`}
          tone={providers.length > 0 && availableProviders === 0 ? 'danger' : 'default'}
        />
      </div>

      <div className={styles.columns}>
        <div className={styles.stack}>
          <Card
            title="Recent runs"
            actions={
              <Button size="sm" onClick={() => navigate('/runs')}>
                View all
              </Button>
            }
          >
            {runsQuery.loading ? (
              <Spinner />
            ) : runs.length === 0 ? (
              <EmptyState
                icon="▶"
                title="No runs yet"
                hint="Runs appear here once work is discovered from a configured source, or you trigger one manually from the Work page."
                action={
                  <Button variant="primary" size="sm" onClick={() => navigate('/work')}>
                    Browse work items
                  </Button>
                }
              />
            ) : (
              <Table
                rows={runs.slice(0, 10)}
                rowKey={(run) => run.id}
                onRowClick={(run) => navigate(`/runs/${run.id}`)}
                columns={[
                  {
                    key: 'workItem',
                    header: 'Work item',
                    render: (run: Run) => <span className="mono">{run.workItemId}</span>,
                  },
                  { key: 'workflow', header: 'Workflow', render: (run: Run) => run.workflowName },
                  {
                    key: 'state',
                    header: 'State',
                    render: (run: Run) => <StateBadge state={run.state} />,
                  },
                  {
                    key: 'updated',
                    header: 'Updated',
                    render: (run: Run) => relativeTime(run.updatedAt),
                  },
                ]}
              />
            )}
          </Card>

          <Card title="Live events" subtitle="Most recent activity across all runs">
            {events.length === 0 ? (
              <EmptyState
                icon="◈"
                title="No activity yet"
                hint="Events will stream here in real time."
              />
            ) : (
              <div className={styles.ticker}>
                {[...events].reverse().map((event) => (
                  <div key={event.id} className={styles.tickerRow}>
                    <span className={styles.tickerTime}>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                    <span className={styles.tickerText}>{describeEvent(event)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className={styles.stack}>
          <Card
            title="Pending approvals"
            subtitle={approvals.length > 0 ? `${approvals.length} waiting` : undefined}
          >
            {approvalsQuery.loading ? (
              <Spinner />
            ) : approvals.length === 0 ? (
              <EmptyState
                icon="✓"
                title="Nothing waiting"
                hint="Approval requests from policy or workflow steps show up here."
              />
            ) : (
              approvals.map((approval) => (
                <div key={approval.id} className={styles.approvalRow}>
                  <div className={styles.approvalMeta}>
                    <div className={styles.approvalCapability}>{approval.request.capability}</div>
                    <div className={styles.approvalTarget}>{approval.request.target ?? '—'}</div>
                  </div>
                  <div className={styles.approvalActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={resolvingId === approval.id}
                      onClick={() => void handleApproval(approval.id, true)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={resolvingId === approval.id}
                      onClick={() => void handleApproval(approval.id, false)}
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card title="Providers">
            {providersQuery.loading ? (
              <Spinner />
            ) : providers.length === 0 ? (
              <EmptyState
                icon="◎"
                title="No providers configured"
                hint="Add model, agent, or work providers to your config file."
              />
            ) : (
              providers.slice(0, 8).map((p) => (
                <div key={p.info.id} className={styles.approvalRow}>
                  <div className={styles.approvalMeta}>
                    <div className={styles.approvalCapability}>{p.info.displayName}</div>
                    <div className={styles.approvalTarget}>{p.info.kind}</div>
                  </div>
                  <Badge tone={p.availability.available ? 'success' : 'neutral'}>
                    {p.availability.available ? 'available' : 'unavailable'}
                  </Badge>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
