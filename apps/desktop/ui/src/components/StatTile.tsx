import type { ReactNode } from 'react'
import styles from './StatTile.module.css'

export interface StatTileProps {
  readonly label: string
  readonly value: ReactNode
  readonly sub?: ReactNode
  readonly tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger'
}

export function StatTile({ label, value, sub, tone = 'default' }: StatTileProps): JSX.Element {
  return (
    <div className={[styles.tile, tone !== 'default' ? styles[`tone-${tone}`] : ''].join(' ')}>
      <div className={styles.label}>{label}</div>
      <div className={styles.row}>
        <span className={styles.value}>{value}</span>
      </div>
      {sub && <div className={styles.sub}>{sub}</div>}
    </div>
  )
}
