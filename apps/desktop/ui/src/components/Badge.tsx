import type { CSSProperties, ReactNode } from 'react'
import type { RunState } from '../api/types'
import styles from './Badge.module.css'

interface StateStyle {
  readonly color: string
  readonly background: string
  readonly label: string
  readonly pulse?: boolean
}

const STATE_STYLES: Record<RunState, StateStyle> = {
  QUEUED: { color: 'var(--state-queued)', background: 'var(--state-queued-bg)', label: 'Queued' },
  PREPARING: {
    color: 'var(--state-running)',
    background: 'var(--state-running-bg)',
    label: 'Preparing',
  },
  RUNNING: {
    color: 'var(--state-running)',
    background: 'var(--state-running-bg)',
    label: 'Running',
    pulse: true,
  },
  WAITING_FOR_TOOL: {
    color: 'var(--state-waiting)',
    background: 'var(--state-waiting-bg)',
    label: 'Waiting on tool',
  },
  WAITING_FOR_SUBAGENT: {
    color: 'var(--state-waiting)',
    background: 'var(--state-waiting-bg)',
    label: 'Waiting on subagent',
  },
  WAITING_FOR_HUMAN: {
    color: 'var(--state-waiting)',
    background: 'var(--state-waiting-bg)',
    label: 'Waiting on human',
  },
  VERIFYING: {
    color: 'var(--state-verifying)',
    background: 'var(--state-verifying-bg)',
    label: 'Verifying',
  },
  COMPLETED: {
    color: 'var(--state-completed)',
    background: 'var(--state-completed-bg)',
    label: 'Completed',
  },
  FAILED: { color: 'var(--state-failed)', background: 'var(--state-failed-bg)', label: 'Failed' },
  BLOCKED: {
    color: 'var(--state-blocked)',
    background: 'var(--state-blocked-bg)',
    label: 'Blocked',
  },
  CANCELLED: {
    color: 'var(--state-cancelled)',
    background: 'var(--state-cancelled-bg)',
    label: 'Cancelled',
  },
}

export interface StateBadgeProps {
  readonly state: RunState
  readonly className?: string
}

/** State-colored badge for a `RunState`. */
export function StateBadge({ state, className }: StateBadgeProps): JSX.Element {
  const style = STATE_STYLES[state]
  const cssVars: CSSProperties = { color: style.color, background: style.background }
  return (
    <span
      className={[styles.badge, style.pulse ? styles.pulse : '', className]
        .filter(Boolean)
        .join(' ')}
      style={cssVars}
    >
      <span className={styles.dot} />
      {style.label}
    </span>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONE_VARS: Record<BadgeTone, CSSProperties> = {
  neutral: { color: 'var(--color-text-muted)', background: 'var(--color-bg-active)' },
  accent: { color: 'var(--color-accent)', background: 'var(--color-accent-muted)' },
  success: { color: 'var(--color-success)', background: 'var(--color-success-muted)' },
  warning: { color: 'var(--color-warning)', background: 'var(--color-warning-muted)' },
  danger: { color: 'var(--color-danger)', background: 'var(--color-danger-muted)' },
}

export interface BadgeProps {
  readonly tone?: BadgeTone
  readonly children: ReactNode
  readonly className?: string
}

/** Generic label badge for tones not tied to run state (labels, kinds, counts). */
export function Badge({ tone = 'neutral', children, className }: BadgeProps): JSX.Element {
  return (
    <span className={[styles.badge, className].filter(Boolean).join(' ')} style={TONE_VARS[tone]}>
      {children}
    </span>
  )
}
