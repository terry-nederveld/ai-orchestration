/**
 * Detail view for a durable graph run (GET /api/graph-runs/:id): run state
 * plus domain state and spec revision, the active/waiting node set, the
 * node result history newest-first with expandable outputs, and any open
 * waits answerable inline.
 */
import type { ApiClient } from '../../api/client'
import type { GraphNodeResult, GraphRunView } from '../../api/types'
import { Badge, StateBadge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { relativeTime } from '../../lib/format'
import { WaitResponseForm } from '../approvals/WaitResponseForm'
import styles from './RunDetail.module.css'

export interface GraphRunDetailProps {
  readonly view: GraphRunView
  /** Client of the connection that owns this run. */
  readonly client: ApiClient
  readonly connectionName?: string
  readonly onChanged?: () => void
}

export function GraphRunDetail({
  view,
  client,
  connectionName,
  onChanged,
}: GraphRunDetailProps): JSX.Element {
  const { run, state, openWaits } = view

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headerMeta}>
          <div className={styles.title}>
            <span className={styles.workItem}>{run?.workItemId ?? state.runId}</span>
            {run && <StateBadge state={run.state} />}
            {state.domain.name && <Badge tone="accent">{state.domain.name}</Badge>}
          </div>
          <div className={styles.subline}>
            {run && <span>{run.workflowName}</span>}
            <span className="mono">{state.runId}</span>
            <span>spec revision {state.specRevision}</span>
            {connectionName && <Badge tone="neutral">{connectionName}</Badge>}
            <span>updated {relativeTime(state.updatedAt)}</span>
          </div>
        </div>
      </div>

      {run?.error && <div className={styles.errorBanner}>{run.error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <Card title="Nodes">
          <div className={styles.graphMeta}>
            <span>Active:</span>
            {state.activeNodeIds.length === 0 ? (
              <span>none</span>
            ) : (
              <span className={styles.nodeChips}>
                {state.activeNodeIds.map((nodeId) => (
                  <span key={nodeId} className={styles.nodeChip}>
                    {nodeId}
                  </span>
                ))}
              </span>
            )}
            <span>Waiting:</span>
            {state.waitingNodeIds.length === 0 ? (
              <span>none</span>
            ) : (
              <span className={styles.nodeChips}>
                {state.waitingNodeIds.map((nodeId) => (
                  <span key={nodeId} className={styles.nodeChip}>
                    {nodeId}
                  </span>
                ))}
              </span>
            )}
          </div>
        </Card>

        {openWaits.length > 0 && (
          <Card title="Needs you" subtitle={`${openWaits.length} open`}>
            {openWaits.map((wait) => (
              <div key={wait.id} className={styles.waitBlock}>
                <div className={styles.waitBlockHeader}>
                  <Badge tone="accent">{wait.kind}</Badge>
                  <span>node {wait.nodeId}</span>
                  <span>· opened {relativeTime(wait.createdAt)}</span>
                </div>
                <WaitResponseForm wait={wait} client={client} onResolved={onChanged} />
              </div>
            ))}
          </Card>
        )}

        <Card title="Result history" subtitle="Newest first">
          {state.resultHistory.length === 0 ? (
            <EmptyState icon="⌁" title="No node results yet" />
          ) : (
            <div className={styles.historyList}>
              {state.resultHistory.map((result) => (
                <HistoryEntry
                  key={`${result.nodeId}:${result.attempt}:${result.startedAt}:${result.settledAt}`}
                  result={result}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

const RESULT_TONE = {
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
} as const

function HistoryEntry({ result }: { readonly result: GraphNodeResult }): JSX.Element {
  const hasOutputs = Object.keys(result.outputs).length > 0
  return (
    <details className={styles.historyEntry}>
      <summary className={styles.historySummary}>
        <span className={styles.historyNode}>{result.nodeId}</span>
        <Badge tone={RESULT_TONE[result.status]}>{result.status}</Badge>
        <span>attempt {result.attempt}</span>
        <span className={styles.historyMeta}>{relativeTime(result.settledAt)}</span>
      </summary>
      <div className={styles.historyOutputs}>
        {result.error && <div className={styles.errorBanner}>{result.error}</div>}
        <pre
          className="mono"
          style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {hasOutputs ? JSON.stringify(result.outputs, null, 2) : 'no outputs'}
        </pre>
      </div>
    </details>
  )
}
