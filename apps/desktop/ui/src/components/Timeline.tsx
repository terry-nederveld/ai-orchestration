import type { StepTimelineEntry } from '../features/runs/timeline'
import styles from './Timeline.module.css'

function duration(startedAt?: string, finishedAt?: string): string | undefined {
  if (!startedAt || !finishedAt) return undefined
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

const STATUS_LABEL: Record<StepTimelineEntry['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
}

export interface TimelineProps {
  readonly steps: readonly StepTimelineEntry[]
}

export function Timeline({ steps }: TimelineProps): JSX.Element {
  return (
    <ol className={styles.list}>
      {steps.map((step) => (
        <li key={step.stepId} className={styles.item}>
          <div className={styles.rail}>
            <span className={[styles.dot, styles[step.status]].join(' ')} aria-hidden="true" />
          </div>
          <div className={styles.content}>
            <div className={styles.stepId}>{step.stepId}</div>
            <div className={styles.meta}>
              {STATUS_LABEL[step.status]}
              {duration(step.startedAt, step.finishedAt) &&
                ` · ${duration(step.startedAt, step.finishedAt)}`}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
