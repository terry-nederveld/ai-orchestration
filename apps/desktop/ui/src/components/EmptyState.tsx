import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  readonly icon?: ReactNode
  readonly title: string
  readonly hint?: ReactNode
  readonly action?: ReactNode
}

export function EmptyState({ icon = '○', title, hint, action }: EmptyStateProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon} aria-hidden="true">
        {icon}
      </div>
      <div className={styles.title}>{title}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
      {action && <div className={styles.actions}>{action}</div>}
    </div>
  )
}
