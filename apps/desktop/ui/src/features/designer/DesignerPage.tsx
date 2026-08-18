/**
 * Designer home: browse stored workflow definitions (ADR-0018 lifecycle)
 * and drive draft/enable/disable. Selecting one opens the graph editor.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useConnection } from '../../api/connection'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge, type BadgeTone } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { listWorkflowDefinitions, setWorkflowLifecycle } from './api'
import styles from './designer.module.css'
import type { DefinitionLifecycle, WorkflowDefinitionStatus } from './types'

const LIFECYCLE_TONES: Record<DefinitionLifecycle, BadgeTone> = {
  draft: 'neutral',
  enabled: 'success',
  disabled: 'warning',
}

export function DesignerPage(): JSX.Element {
  const navigate = useNavigate()
  const { client } = useConnection()
  const query = useApiQuery((c) => listWorkflowDefinitions(c))
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const definitions = query.data ?? []

  const changeLifecycle = async (
    definition: WorkflowDefinitionStatus,
    lifecycle: DefinitionLifecycle,
  ) => {
    if (!client) return
    if (definition.lifecycle === 'enabled' && lifecycle === 'disabled') {
      const confirmed = window.confirm(
        `Disable '${definition.name}'? New runs will stop selecting it; in-flight runs finish on their pinned version.`,
      )
      if (!confirmed) return
    }
    setBusyName(definition.name)
    setActionError(null)
    try {
      await setWorkflowLifecycle(client, definition.name, lifecycle)
      query.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyName(null)
    }
  }

  return (
    <Card
      title="Workflow designer"
      subtitle="Stored workflow definitions; select one to view and edit its graph."
      flush
    >
      {query.loading ? (
        <div style={{ padding: 'var(--space-6)' }}>
          <Spinner />
        </div>
      ) : query.error ? (
        <EmptyState icon="!" title="Couldn't load definitions" hint={query.error} />
      ) : definitions.length === 0 ? (
        <EmptyState
          icon="✎"
          title="No stored workflow definitions"
          hint="Definitions saved through the designer or the API appear here with their lifecycle."
        />
      ) : (
        <>
          {actionError && (
            <div className={styles.errorText} style={{ padding: 'var(--space-3)' }} role="alert">
              {actionError}
            </div>
          )}
          <Table
            rows={definitions}
            rowKey={(definition) => definition.name}
            onRowClick={(definition) =>
              navigate(`/designer/${encodeURIComponent(definition.name)}`)
            }
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (definition: WorkflowDefinitionStatus) => (
                  <strong>{definition.name}</strong>
                ),
              },
              {
                key: 'lifecycle',
                header: 'Lifecycle',
                render: (definition: WorkflowDefinitionStatus) => (
                  <Badge tone={LIFECYCLE_TONES[definition.lifecycle]}>{definition.lifecycle}</Badge>
                ),
              },
              {
                key: 'version',
                header: 'Latest version',
                render: (definition: WorkflowDefinitionStatus) => `v${definition.latestVersion}`,
              },
              {
                key: 'actions',
                header: 'Lifecycle actions',
                render: (definition: WorkflowDefinitionStatus) => (
                  <div className={styles.lifecycleActions}>
                    {(['draft', 'enabled', 'disabled'] as const)
                      .filter((lifecycle) => lifecycle !== definition.lifecycle)
                      .map((lifecycle) => (
                        <Button
                          key={lifecycle}
                          size="sm"
                          loading={busyName === definition.name}
                          onClick={(event) => {
                            event.stopPropagation()
                            void changeLifecycle(definition, lifecycle)
                          }}
                        >
                          {lifecycle === 'draft'
                            ? 'Mark draft'
                            : lifecycle === 'enabled'
                              ? 'Enable'
                              : 'Disable'}
                        </Button>
                      ))}
                  </div>
                ),
              },
            ]}
          />
        </>
      )}
    </Card>
  )
}
