import type { ReactNode } from 'react'
import styles from './Table.module.css'

export interface TableColumn<T> {
  readonly key: string
  readonly header: ReactNode
  readonly render: (row: T) => ReactNode
  readonly width?: string
}

export interface TableProps<T> {
  readonly columns: readonly TableColumn<T>[]
  readonly rows: readonly T[]
  readonly rowKey: (row: T) => string
  readonly onRowClick?: (row: T) => void
}

export function Table<T>({ columns, rows, rowKey, onRowClick }: TableProps<T>): JSX.Element {
  return (
    <div className={styles.wrap}>
      <table className={[styles.table, onRowClick ? styles.clickable : ''].join(' ')}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={column.width ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter') onRowClick(row)
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
