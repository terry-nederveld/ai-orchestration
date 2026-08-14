import styles from './Tabs.module.css'

export interface TabItem {
  readonly key: string
  readonly label: string
  readonly badge?: number
}

export interface TabsProps {
  readonly items: readonly TabItem[]
  readonly active: string
  readonly onChange: (key: string) => void
}

export function Tabs({ items, active, onChange }: TabsProps): JSX.Element {
  return (
    <div className={styles.list} role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === active}
          className={[styles.tab, item.key === active ? styles.active : ''].join(' ')}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.badge !== undefined && item.badge > 0 ? ` (${item.badge})` : ''}
        </button>
      ))}
    </div>
  )
}
