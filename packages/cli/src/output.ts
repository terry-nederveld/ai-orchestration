/**
 * Terminal output helpers. Plain text, no colors library — respects NO_COLOR
 * by simply never emitting escape codes.
 */

export interface Column<T> {
  readonly header: string
  readonly value: (row: T) => string
}

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
  )
  const line = (cells: readonly string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')
  const out = [line(columns.map((column) => column.header))]
  out.push(line(widths.map((width) => '-'.repeat(width))))
  for (const row of rows) {
    out.push(line(columns.map((column) => column.value(row))))
  }
  return out.join('\n')
}

export function formatDate(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

export function shortId(id: string, length = 18): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}
