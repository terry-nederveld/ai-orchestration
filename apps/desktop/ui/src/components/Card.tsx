import type { ReactNode } from 'react'
import styles from './Card.module.css'

export interface CardProps {
  readonly title?: ReactNode
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  readonly flush?: boolean
  readonly children: ReactNode
  readonly className?: string
}

export function Card({
  title,
  subtitle,
  actions,
  flush,
  children,
  className,
}: CardProps): JSX.Element {
  return (
    <section className={[styles.card, className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header className={styles.header}>
          <div>
            {title && <div className={styles.title}>{title}</div>}
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={[styles.body, flush ? styles.flush : ''].filter(Boolean).join(' ')}>
        {children}
      </div>
    </section>
  )
}
