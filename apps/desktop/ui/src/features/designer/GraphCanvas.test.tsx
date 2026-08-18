import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { deliveryFixture, discoveryFixture } from './flagship-fixtures'
import { GraphCanvas } from './GraphCanvas'

describe('GraphCanvas', () => {
  for (const [label, graph] of [
    ['delivery', deliveryFixture],
    ['discovery', discoveryFixture],
  ] as const) {
    it(`renders every ${label} node and transition`, () => {
      render(<GraphCanvas graph={graph} selection={null} onSelect={() => {}} />)
      for (const node of graph.nodes) {
        expect(screen.getByRole('button', { name: `node ${node.id}` })).toBeInTheDocument()
      }
      for (const transition of graph.transitions) {
        expect(screen.getByTestId(`edge-${transition.id}`)).toBeInTheDocument()
      }
    })
  }

  it('selects nodes and transitions on click', () => {
    const onSelect = vi.fn()
    render(<GraphCanvas graph={deliveryFixture} selection={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'node plan' }))
    expect(onSelect).toHaveBeenLastCalledWith({ type: 'node', id: 'plan' })
    fireEvent.click(screen.getByTestId('edge-review-remediate'))
    expect(onSelect).toHaveBeenLastCalledWith({ type: 'transition', id: 'review-remediate' })
  })
})
