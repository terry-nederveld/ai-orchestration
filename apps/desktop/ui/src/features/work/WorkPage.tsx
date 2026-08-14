import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useConnection } from '../../api/connection'
import type { WorkItem } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { useStatus } from '../../api/useStatus'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { useToast } from '../../components/Toast'
import styles from './WorkPage.module.css'

export function WorkPage(): JSX.Element {
  const { status } = useStatus()
  const sources = status?.workSources ?? []
  const [source, setSource] = useState<string | null>(null)
  const activeSource = source ?? sources[0] ?? null

  const workflowsQuery = useApiQuery((client) => client.listWorkflows())
  const itemsQuery = useApiQuery(
    (client) => (activeSource ? client.listWorkItems(activeSource) : Promise.resolve([])),
    [activeSource],
  )

  if (status && sources.length === 0) {
    return (
      <EmptyState
        icon="☰"
        title="No work sources configured"
        hint="Add a work provider (GitHub, Jira, Linear, …) to the daemon's config file so it can discover work."
      />
    )
  }

  return (
    <div>
      <div className={styles.sourceTabs}>
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            className={[styles.sourceTab, s === activeSource ? styles.sourceTabActive : ''].join(
              ' ',
            )}
            onClick={() => setSource(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <Card flush>
        {itemsQuery.loading ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Spinner />
          </div>
        ) : itemsQuery.error ? (
          <EmptyState icon="!" title="Couldn't load work items" hint={itemsQuery.error} />
        ) : (itemsQuery.data ?? []).length === 0 ? (
          <EmptyState
            icon="☰"
            title="No items found"
            hint="This source has no items matching the default query."
          />
        ) : (
          <ItemsTable
            items={itemsQuery.data ?? []}
            source={activeSource ?? ''}
            workflows={(workflowsQuery.data ?? []).map((w) => w.name)}
          />
        )}
      </Card>
    </div>
  )
}

function ItemsTable({
  items,
  source,
  workflows,
}: {
  readonly items: readonly WorkItem[]
  readonly source: string
  readonly workflows: readonly string[]
}): JSX.Element {
  const navigate = useNavigate()
  const { client } = useConnection()
  const { push } = useToast()
  const [selectedWorkflow, setSelectedWorkflow] = useState<Record<string, string>>({})
  const [runningId, setRunningId] = useState<string | null>(null)

  const triggerRun = async (item: WorkItem) => {
    if (!client) return
    setRunningId(item.externalId)
    try {
      const workflow = selectedWorkflow[item.externalId]
      const run = await client.createRun(`${source}:${item.externalId}`, workflow || undefined)
      push('Run started', 'success')
      navigate(`/runs/${run.id}`)
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to start run', 'error')
    } finally {
      setRunningId(null)
    }
  }

  return (
    <Table
      rows={items}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'title',
          header: 'Item',
          render: (item) => (
            <div>
              <div>{item.title}</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--color-text-faint)' }}>
                {item.externalId}
              </div>
            </div>
          ),
        },
        { key: 'state', header: 'State', render: (item) => <Badge>{item.state}</Badge> },
        {
          key: 'labels',
          header: 'Labels',
          render: (item) => (
            <div className={styles.labels}>
              {item.labels.map((label) => (
                <Badge key={label} tone="neutral">
                  {label}
                </Badge>
              ))}
            </div>
          ),
        },
        {
          key: 'actions',
          header: '',
          render: (item) => (
            <div className={styles.rowActions}>
              {workflows.length > 0 && (
                <select
                  className={styles.select}
                  value={selectedWorkflow[item.externalId] ?? ''}
                  onChange={(e) =>
                    setSelectedWorkflow((prev) => ({ ...prev, [item.externalId]: e.target.value }))
                  }
                >
                  <option value="">auto-select workflow</option>
                  {workflows.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                size="sm"
                variant="primary"
                loading={runningId === item.externalId}
                onClick={() => void triggerRun(item)}
              >
                Run
              </Button>
            </div>
          ),
        },
      ]}
    />
  )
}
