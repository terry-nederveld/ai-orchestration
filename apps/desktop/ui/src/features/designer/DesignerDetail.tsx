/**
 * One workflow definition in the designer: graph editor (canvas + YAML over
 * the same canonical document) plus the side-effect-free Evaluate panel.
 */

import { useParams } from 'react-router'
import { useConnection } from '../../api/connection'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge } from '../../components/Badge'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import {
  evaluateWorkflow,
  getWorkflowDefinition,
  saveWorkflowDefinition,
  validateWorkflowDocument,
} from './api'
import styles from './designer.module.css'
import { EvaluatePanel } from './EvaluatePanel'
import { GraphEditor } from './GraphEditor'

export function DesignerDetail(): JSX.Element {
  const { name } = useParams<{ name: string }>()
  const { client } = useConnection()
  const query = useApiQuery((c) => getWorkflowDefinition(c, name ?? ''), [name])
  const detail = query.data

  if (query.loading) return <Spinner />
  if (query.error)
    return <EmptyState icon="!" title="Couldn't load definition" hint={query.error} />
  if (!detail || !client)
    return <EmptyState icon="?" title="Definition not found" hint={`No workflow named '${name}'`} />

  return (
    <div>
      <div className={styles.headerRow}>
        <span className={styles.workflowName}>{detail.name}</span>
        <Badge tone={detail.lifecycle === 'enabled' ? 'success' : 'neutral'}>
          {detail.lifecycle}
        </Badge>
        <span className={styles.toolbarNote}>
          v{detail.definition.version} of {detail.latestVersion}
        </span>
      </div>

      <GraphEditor
        key={`${detail.name}@${detail.definition.version}`}
        name={detail.name}
        initialDocument={detail.definition.document}
        onValidate={(doc) => validateWorkflowDocument(client, doc)}
        onSave={async (doc) => {
          const saved = await saveWorkflowDefinition(client, detail.name, doc)
          query.reload()
          return saved
        }}
      />

      <div className={styles.reportSection}>
        <EvaluatePanel
          workflowName={detail.name}
          runEvaluate={(body) => evaluateWorkflow(client, body)}
        />
      </div>
    </div>
  )
}
