import { useState } from 'react'
import { useConnection } from '../../api/connection'
import type { PendingApproval } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { useToast } from '../../components/Toast'
import { relativeTime } from '../../lib/format'

export function ApprovalsPage(): JSX.Element {
  const { client } = useConnection()
  const { push } = useToast()
  const query = useApiQuery((c) => c.listApprovals())
  const approvals = query.data ?? []
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const resolve = async (id: string, approved: boolean) => {
    if (!client) return
    setResolvingId(id)
    try {
      const result = await client.resolveApproval(id, approved)
      if (result.resolved) {
        push(approved ? 'Approved' : 'Denied', 'success')
        query.reload()
      } else {
        push('This request already resolved or timed out', 'error')
      }
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to resolve approval', 'error')
    } finally {
      setResolvingId(null)
    }
  }

  return (
    <Card flush>
      {query.loading ? (
        <div style={{ padding: 'var(--space-6)' }}>
          <Spinner />
        </div>
      ) : query.error ? (
        <EmptyState icon="!" title="Couldn't load approvals" hint={query.error} />
      ) : approvals.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Nothing waiting on you"
          hint="When policy marks an operation as 'ask', or a workflow hits an approval step, it shows up here until approved or denied."
        />
      ) : (
        <Table
          rows={approvals}
          rowKey={(a) => a.id}
          columns={[
            {
              key: 'capability',
              header: 'Capability',
              render: (a: PendingApproval) => <span className="mono">{a.request.capability}</span>,
            },
            {
              key: 'target',
              header: 'Target',
              render: (a: PendingApproval) => a.request.target ?? '—',
            },
            {
              key: 'run',
              header: 'Run',
              render: (a: PendingApproval) =>
                a.request.runId ? <span className="mono">{a.request.runId}</span> : '—',
            },
            {
              key: 'decision',
              header: 'Policy',
              render: (a: PendingApproval) => (
                <Badge tone={a.decision.effect === 'deny' ? 'danger' : 'warning'}>
                  {a.decision.effect}
                </Badge>
              ),
            },
            {
              key: 'age',
              header: 'Requested',
              render: (a: PendingApproval) => relativeTime(a.requestedAt),
            },
            {
              key: 'actions',
              header: '',
              render: (a: PendingApproval) => (
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={resolvingId === a.id}
                    onClick={() => void resolve(a.id, true)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={resolvingId === a.id}
                    onClick={() => void resolve(a.id, false)}
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
  )
}
