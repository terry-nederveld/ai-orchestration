import { type ReactNode, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useConnection } from '../../api/connection'
import { useEventStream } from '../../api/events'
import { TERMINAL_RUN_STATES } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { StateBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Tabs } from '../../components/Tabs'
import { Timeline } from '../../components/Timeline'
import { useToast } from '../../components/Toast'
import { describeEvent } from '../../lib/describeEvent'
import { formatCost, formatTokens, relativeTime } from '../../lib/format'
import styles from './RunDetail.module.css'
import { reduceRunTimeline, type ToolCallEntry, type TranscriptEntry } from './timeline'

const RETRYABLE_STATES = new Set(['FAILED', 'BLOCKED', 'CANCELLED'])

export function RunDetail(): JSX.Element {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const { client } = useConnection()
  const { push } = useToast()
  const [tab, setTab] = useState<'overview' | 'events'>('overview')
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null)

  const runQuery = useApiQuery((c) => c.getRun(runId ?? ''), [runId])
  const historyQuery = useApiQuery((c) => c.getRunEvents(runId ?? ''), [runId])

  const { events: liveEvents } = useEventStream(runId, {
    maxEvents: 2000,
    onEvent: (event) => {
      if (event.type === 'run.state.changed' || event.type === 'workflow.transitioned') {
        runQuery.reload()
      }
    },
  })

  const allEvents = useMemo(() => {
    const history = historyQuery.data ?? []
    const seen = new Set(history.map((e) => e.id))
    const merged = [...history]
    for (const event of liveEvents) {
      if (!seen.has(event.id)) {
        merged.push(event)
        seen.add(event.id)
      }
    }
    return merged
  }, [historyQuery.data, liveEvents])

  const timelineModel = useMemo(() => reduceRunTimeline(allEvents), [allEvents])

  const run = runQuery.data

  const handleCancel = async () => {
    if (!client || !runId) return
    setBusy('cancel')
    try {
      const result = await client.cancelRun(runId)
      if (result.cancelled) {
        push('Run cancelled', 'success')
        runQuery.reload()
      } else {
        push('Run could not be cancelled (already finished)', 'error')
      }
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to cancel run', 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleRetry = async () => {
    if (!client || !runId) return
    setBusy('retry')
    try {
      const next = await client.retryRun(runId)
      push('Retry queued', 'success')
      navigate(`/runs/${next.id}`)
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to retry run', 'error')
    } finally {
      setBusy(null)
    }
  }

  if (runQuery.loading && !run) {
    return <Spinner />
  }

  if (runQuery.error && !run) {
    return <EmptyState icon="!" title="Couldn't load run" hint={runQuery.error} />
  }

  if (!run) {
    return <EmptyState icon="?" title="Run not found" hint={`No run with id ${runId}`} />
  }

  const isTerminal = TERMINAL_RUN_STATES.includes(run.state)
  const canRetry = RETRYABLE_STATES.has(run.state)

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headerMeta}>
          <div className={styles.title}>
            <span className={styles.workItem}>{run.workItemId}</span>
            <StateBadge state={run.state} />
          </div>
          <div className={styles.subline}>
            <span>{run.workflowName}</span>
            <span className="mono">{run.id}</span>
            <span>created {relativeTime(run.createdAt)}</span>
            <span>updated {relativeTime(run.updatedAt)}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          {!isTerminal && (
            <Button
              variant="danger"
              loading={busy === 'cancel'}
              onClick={() => void handleCancel()}
            >
              Cancel
            </Button>
          )}
          {canRetry && (
            <Button variant="primary" loading={busy === 'retry'} onClick={() => void handleRetry()}>
              Retry
            </Button>
          )}
        </div>
      </div>

      {run.error && <div className={styles.errorBanner}>{run.error}</div>}

      <Tabs
        items={[
          { key: 'overview', label: 'Overview' },
          { key: 'events', label: 'Raw events', badge: allEvents.length },
        ]}
        active={tab}
        onChange={(key) => setTab(key as 'overview' | 'events')}
      />

      <div style={{ height: 'var(--space-5)' }} />

      {tab === 'overview' ? (
        <div className={styles.columns}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <Card title="Steps">
              {timelineModel.steps.length === 0 ? (
                <EmptyState icon="⌁" title="No steps yet" />
              ) : (
                <Timeline steps={timelineModel.steps} />
              )}
            </Card>

            <Card title="Usage">
              <div className={styles.usageGrid}>
                <div className={styles.usageItem}>
                  <span className={styles.usageLabel}>Input tokens</span>
                  <span className={styles.usageValue}>
                    {formatTokens(run.usage?.tokens.inputTokens ?? timelineModel.usage.inputTokens)}
                  </span>
                </div>
                <div className={styles.usageItem}>
                  <span className={styles.usageLabel}>Output tokens</span>
                  <span className={styles.usageValue}>
                    {formatTokens(
                      run.usage?.tokens.outputTokens ?? timelineModel.usage.outputTokens,
                    )}
                  </span>
                </div>
                <div className={styles.usageItem}>
                  <span className={styles.usageLabel}>Turns</span>
                  <span className={styles.usageValue}>
                    {run.usage?.turns ?? timelineModel.usage.turns}
                  </span>
                </div>
                <div className={styles.usageItem}>
                  <span className={styles.usageLabel}>Est. cost</span>
                  <span className={styles.usageValue}>
                    {formatCost(run.usage?.estimatedCostUsd)}
                  </span>
                </div>
              </div>
            </Card>
          </div>

          <Card title="Agent output" flush>
            {timelineModel.transcript.length === 0 ? (
              <EmptyState
                icon="…"
                title="No agent output yet"
                hint="Text and tool calls will stream in as the agent works."
              />
            ) : (
              <div className={styles.transcript} style={{ padding: 'var(--space-5)' }}>
                {timelineModel.transcript.map((entry, index) => (
                  // Transcript entries are appended in stream order and
                  // never reordered or removed (only the last text/thinking
                  // entry is ever mutated in place), so the index is a
                  // stable identity here.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <TranscriptEntryView key={index} entry={entry} />
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card flush>
          {allEvents.length === 0 ? (
            <EmptyState icon="≡" title="No events recorded" />
          ) : (
            <div className={styles.eventLog} style={{ padding: 'var(--space-5)' }}>
              {[...allEvents].reverse().map((event) => (
                <div key={event.id} className={styles.eventRow}>
                  <span className={styles.eventTime}>
                    {new Date(event.at).toLocaleTimeString()}
                  </span>
                  <span className={styles.eventType}>{event.type}</span>
                  <span className={styles.eventDetail}>{describeEvent(event)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function TranscriptEntryView({ entry }: { readonly entry: TranscriptEntry }): ReactNode {
  switch (entry.kind) {
    case 'text':
      return (
        <div>
          <span className={styles.sessionLabel}>{entry.sessionId}</span>
          <div className={styles.textBlock}>{entry.text}</div>
        </div>
      )
    case 'thinking':
      return <div className={styles.thinkingBlock}>{entry.text}</div>
    case 'tool':
      return <ToolCallView call={entry.call} />
    case 'waiting-human':
      return <div className={styles.notice}>Waiting on a human: {entry.reason}</div>
    case 'subagent':
      return (
        <div className={styles.subagentNotice}>
          Subagent {entry.childSessionId} {entry.status}
          {entry.outcome ? ` (${entry.outcome})` : ''}
        </div>
      )
    default:
      return null
  }
}

function ToolCallView({ call }: { readonly call: ToolCallEntry }): JSX.Element {
  return (
    <details className={styles.toolEntry}>
      <summary className={styles.toolSummary}>
        <span className={styles.toolName}>{call.toolName}</span>
        <StatusDot status={call.status} />
        {call.status === 'running' ? 'running' : call.status}
      </summary>
      <div className={styles.toolBody}>
        <div>
          <div className={styles.toolFieldLabel}>Input</div>
          <pre
            className="mono"
            style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {JSON.stringify(call.input, null, 2)}
          </pre>
        </div>
        {call.result !== undefined && (
          <div>
            <div className={styles.toolFieldLabel}>Result</div>
            <pre
              className="mono"
              style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {call.result}
            </pre>
          </div>
        )}
      </div>
    </details>
  )
}

function StatusDot({ status }: { readonly status: ToolCallEntry['status'] }): JSX.Element {
  const color =
    status === 'succeeded'
      ? 'var(--state-completed)'
      : status === 'failed'
        ? 'var(--state-failed)'
        : 'var(--state-running)'
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
      }}
      aria-hidden="true"
    />
  )
}
