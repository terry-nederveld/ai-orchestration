import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Run, RunState } from '../../api/types'
import { RunState as RunStateValues } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { StateBadge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { relativeTime } from '../../lib/format'
import styles from './RunsList.module.css'

const ALL_STATES = Object.values(RunStateValues)

export function RunsList(): JSX.Element {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<RunState | 'ALL'>('ALL')
  const query = useApiQuery(
    (client) => client.listRuns({ limit: 200, ...(filter !== 'ALL' ? { states: [filter] } : {}) }),
    [filter],
  )
  const runs = query.data ?? []

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
        {query.loading ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Spinner />
          </div>
        ) : query.error ? (
          <EmptyState icon="!" title="Couldn't load runs" hint={query.error} />
        ) : runs.length === 0 ? (
          <EmptyState
            icon="▶"
            title={filter === 'ALL' ? 'No runs yet' : `No ${filter.toLowerCase()} runs`}
            hint="Runs appear here once work is discovered from a configured source, or you trigger one manually from the Work page."
          />
        ) : (
          <Table
            rows={runs}
            rowKey={(run) => run.id}
            onRowClick={(run) => navigate(`/runs/${run.id}`)}
            columns={[
              {
                key: 'id',
                header: 'Run',
                render: (run: Run) => <span className="mono">{run.id}</span>,
              },
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
                key: 'created',
                header: 'Created',
                render: (run: Run) => relativeTime(run.createdAt),
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
    </div>
  )
}
