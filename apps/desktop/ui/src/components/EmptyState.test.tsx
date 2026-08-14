import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No runs yet" />)
    expect(screen.getByText('No runs yet')).toBeInTheDocument()
  })

  it('renders an optional hint', () => {
    render(<EmptyState title="Nothing here" hint="Try connecting a work source." />)
    expect(screen.getByText('Try connecting a work source.')).toBeInTheDocument()
  })

  it('omits the hint element entirely when not provided', () => {
    const { container } = render(<EmptyState title="Nothing here" />)
    expect(container.textContent).toBe('○Nothing here')
  })

  it('renders an action when provided', () => {
    render(<EmptyState title="Nothing here" action={<button type="button">Do something</button>} />)
    expect(screen.getByRole('button', { name: 'Do something' })).toBeInTheDocument()
  })

  it('defaults to a generic icon glyph', () => {
    render(<EmptyState title="x" />)
    expect(screen.getByText('○')).toBeInTheDocument()
  })

  it('accepts a custom icon', () => {
    render(<EmptyState title="x" icon="▶" />)
    expect(screen.getByText('▶')).toBeInTheDocument()
  })
})
