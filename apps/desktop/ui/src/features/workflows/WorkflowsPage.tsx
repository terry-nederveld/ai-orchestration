import { useNavigate } from 'react-router'
import type { WorkflowDefinition } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'

export function WorkflowsPage(): JSX.Element {
  const navigate = useNavigate()
  const query = useApiQuery((client) => client.listWorkflows())
  const workflows = query.data ?? []

  return (
    <Card flush>
      {query.loading ? (
        <div style={{ padding: 'var(--space-6)' }}>
          <Spinner />
        </div>
      ) : query.error ? (
        <EmptyState icon="!" title="Couldn't load workflows" hint={query.error} />
      ) : workflows.length === 0 ? (
        <EmptyState
          icon="⌁"
          title="No workflows defined"
          hint="Add a workflow YAML file to the daemon's workflow directory to define how work gets executed."
        />
      ) : (
        <Table
          rows={workflows}
          rowKey={(w) => w.name}
          onRowClick={(w) => navigate(`/workflows/${encodeURIComponent(w.name)}`)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (w: WorkflowDefinition) => <strong>{w.name}</strong>,
            },
            {
              key: 'description',
              header: 'Description',
              render: (w: WorkflowDefinition) => w.description ?? '—',
            },
            { key: 'steps', header: 'Steps', render: (w: WorkflowDefinition) => w.steps.length },
            {
              key: 'trigger',
              header: 'Trigger',
              render: (w: WorkflowDefinition) =>
                w.trigger?.states?.length || w.trigger?.labels?.length ? (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {w.trigger.states?.map((s) => (
                      <Badge key={`s-${s}`}>{s}</Badge>
                    ))}
                    {w.trigger.labels?.map((l) => (
                      <Badge key={`l-${l}`} tone="accent">
                        {l}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
    </Card>
  )
}
