import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Table } from './Table'

interface Row {
  readonly id: string
  readonly name: string
}

const rows: Row[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
]

const columns = [
  { key: 'name', header: 'Name', render: (row: Row) => row.name },
  { key: 'id', header: 'Id', render: (row: Row) => row.id },
]

describe('Table', () => {
  it('renders headers and every row', () => {
    render(<Table rows={rows} columns={columns} rowKey={(r) => r.id} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Id')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('renders no data rows when rows is empty, but keeps the header', () => {
    render(<Table rows={[]} columns={columns} rowKey={(r) => r.id} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.queryAllByRole('row')).toHaveLength(1) // header row only
  })

  it('invokes onRowClick with the clicked row on click', () => {
    const onRowClick = vi.fn()
    render(<Table rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={onRowClick} />)
    fireEvent.click(screen.getByText('Alpha'))
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
  })

  it('invokes onRowClick on Enter for keyboard accessibility', () => {
    const onRowClick = vi.fn()
    render(<Table rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={onRowClick} />)
    const row = screen.getByText('Beta').closest('tr')
    expect(row).not.toBeNull()
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  it('does not make rows focusable or clickable when onRowClick is omitted', () => {
    render(<Table rows={rows} columns={columns} rowKey={(r) => r.id} />)
    const row = screen.getByText('Alpha').closest('tr')
    expect(row).not.toHaveAttribute('tabindex')
  })
})
