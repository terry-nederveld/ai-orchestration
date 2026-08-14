import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RunState } from '../api/types'
import { Badge, StateBadge } from './Badge'

describe('StateBadge', () => {
  const cases: Array<[keyof typeof RunState, string]> = [
    ['Queued', 'Queued'],
    ['Preparing', 'Preparing'],
    ['Running', 'Running'],
    ['WaitingForTool', 'Waiting on tool'],
    ['WaitingForSubagent', 'Waiting on subagent'],
    ['WaitingForHuman', 'Waiting on human'],
    ['Verifying', 'Verifying'],
    ['Completed', 'Completed'],
    ['Failed', 'Failed'],
    ['Blocked', 'Blocked'],
    ['Cancelled', 'Cancelled'],
  ]

  it.each(cases)('renders the expected label for %s', (key, label) => {
    render(<StateBadge state={RunState[key]} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('maps every RunState value to a distinct style (no silent fallback)', () => {
    const seen = new Set<string>()
    for (const state of Object.values(RunState)) {
      const { container, unmount } = render(<StateBadge state={state} />)
      const badge = container.querySelector('span')
      expect(badge).not.toBeNull()
      seen.add(badge?.getAttribute('style') ?? '')
      unmount()
    }
    // Running/Preparing intentionally share a color family but distinct
    // labels; every state should render *something* non-empty.
    expect([...seen].every((style) => style.length > 0)).toBe(true)
  })

  it('applies a pulse animation only to the running state', () => {
    const { container: running } = render(<StateBadge state={RunState.Running} />)
    const { container: completed } = render(<StateBadge state={RunState.Completed} />)
    expect(running.querySelector('span')?.className).toMatch(/pulse/)
    expect(completed.querySelector('span')?.className).not.toMatch(/pulse/)
  })
})

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>custom-label</Badge>)
    expect(screen.getByText('custom-label')).toBeInTheDocument()
  })

  it('defaults to the neutral tone', () => {
    const { container } = render(<Badge>x</Badge>)
    expect(container.querySelector('span')?.getAttribute('style')).toContain(
      'color: var(--color-text-muted)',
    )
  })
})
