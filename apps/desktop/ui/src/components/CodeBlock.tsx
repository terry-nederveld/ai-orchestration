import type { CSSProperties } from 'react'
import styles from './CodeBlock.module.css'

export interface CodeBlockProps {
  readonly children: string
  readonly label?: string
  readonly maxHeight?: number
}

export function CodeBlock({ children, label, maxHeight }: CodeBlockProps): JSX.Element {
  return (
    <div
      className={styles.wrap}
      style={maxHeight ? ({ '--max-height': `${maxHeight}px` } as CSSProperties) : undefined}
    >
      {label && <div className={styles.label}>{label}</div>}
      <pre className={styles.pre}>
        <code>{children}</code>
      </pre>
    </div>
  )
}
