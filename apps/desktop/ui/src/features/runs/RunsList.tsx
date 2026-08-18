import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFederatedQuery } from '../../api/federation'
import type { Run, RunState } from '../../api/types'
import { RunState as RunStateValues } from '../../api/types'
import { Badge, StateBadge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { relativeTime } from '../../lib/format'
import styles from './RunsList.module.css'

const ALL_STATES = Object.values(RunStateValues)

interface RunRow {
  readonly run: Run
  readonly connection: string
  readonly stale: boolean
  readonly lastUpdatedAt: string | null
}

export function RunsList(): JSX.Element {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<RunState | 'ALL'>('ALL')
  const query = useFederatedQuery(
    `runs:${filter}`,
    (client) => client.listRuns({ limit: 200, ...(filter !== 'ALL' ? { states: [filter] } : {}) }),
    [filter],
  )

  const rows: readonly RunRow[] = query.records
    .flatMap((record) =>
      (record.data ?? []).map((run) => ({
        run,
        connection: record.connection,
        stale: record.stale,
        lastUpdatedAt: record.lastUpdatedAt,
      })),
    )
    .sort((a, b) => new Date(b.run.updatedAt).getTime() - new Date(a.run.updatedAt).getTime())

  return (
    <div>
      <div className={styles.filters}>
        <button
          type="button"
          className={[styles.chip, filter === 'ALL' ? styles.chipActive : ''].join(' ')}
          onClick={() => setFilter('ALL')}
        >
          All
        </button>
        {ALL_STATES.map((state) => (
          <button
            key={state}
            type="button"
            className={[styles.chip, filter === state ? styles.chipActive : ''].join(' ')}
            onClick={() => setFilter(state)}
          >
            {state.replace(/_/g, ' ').toLowerCase()}
          </button>
        ))}
      </div>

      <Card flush>
        {query.loading && rows.length === 0 ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="▶"
            title={filter === 'ALL' ? 'No runs yet' : `No ${filter.toLowerCase()} runs`}
            hint="Runs appear here once work is discovered from a configured source, or you trigger one manually from the Work page."
          />
        ) : (
          <Table
            rows={rows}
            rowKey={(row) => `${row.connection}:${row.run.id}`}
            onRowClick={(row) =>
              navigate(
                `/runs/${encodeURIComponent(row.run.id)}?conn=${encodeURIComponent(row.connection)}`,
              )
            }
            columns={[
              {
                key: 'id',
                header: 'Run',
                render: (row: RunRow) => <span className="mono">{row.run.id}</span>,
              },
              {
                key: 'workItem',
                header: 'Work item',
                render: (row: RunRow) => <span className="mono">{row.run.workItemId}</span>,
              },
              {
                key: 'workflow',
                header: 'Workflow',
                render: (row: RunRow) => row.run.workflowName,
              },
              {
                key: 'connection',
                header: 'Connection',
                render: (row: RunRow) => (
                  <>
                    <Badge tone="neutral">{row.connection}</Badge>{' '}
                    {row.stale && <Badge tone="warning">stale</Badge>}
                  </>
                ),
              },
              {
                key: 'state',
                header: 'State',
                render: (row: RunRow) => <StateBadge state={row.run.state} />,
              },
              {
                key: 'created',
                header: 'Created',
                render: (row: RunRow) => relativeTime(row.run.createdAt),
              },
              {
                key: 'updated',
                header: 'Updated',
                render: (row: RunRow) =>
                  row.stale && row.lastUpdatedAt
                    ? `${relativeTime(row.run.updatedAt)} (seen ${relativeTime(row.lastUpdatedAt)})`
                    : relativeTime(row.run.updatedAt),
              },
            ]}
          />
        )}
      </Card>
    </div>
  )
}
