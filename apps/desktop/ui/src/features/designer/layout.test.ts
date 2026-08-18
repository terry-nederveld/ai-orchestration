import { describe, expect, it } from 'vitest'
import { deliveryFixture, discoveryFixture } from './flagship-fixtures'
import { layoutGraph, type PlacedNode } from './layout'

function overlaps(a: PlacedNode, b: PlacedNode): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

describe('layoutGraph', () => {
  for (const [label, graph] of [
    ['delivery', deliveryFixture],
    ['discovery', discoveryFixture],
  ] as const) {
    it(`places every ${label} node without overlap`, () => {
      const layout = layoutGraph(graph)
      expect(layout.nodes.map((node) => node.id).sort()).toEqual(
        graph.nodes.map((node) => node.id).sort(),
      )
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          const a = layout.nodes[i] as PlacedNode
          const b = layout.nodes[j] as PlacedNode
          expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false)
        }
      }
      expect(layout.edges).toHaveLength(graph.transitions.length)
      // Everything fits inside the reported canvas.
      for (const node of layout.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0)
        expect(node.y).toBeGreaterThanOrEqual(0)
        expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
        expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
      }
    })
  }

  it('starts the entry node in the first layer', () => {
    const layout = layoutGraph(deliveryFixture)
    const entry = layout.nodes.find((node) => node.id === 'dor')
    expect(entry).toBeDefined()
    const minY = Math.min(...layout.nodes.map((node) => node.y))
    expect(entry?.y).toBe(minY)
  })

  it('draws the remediation loop closer as a back edge', () => {
    const layout = layoutGraph(deliveryFixture)
    const loop = layout.edges.find((edge) => edge.transition.id === 'rereview-again')
    expect(loop?.kind).toBe('back')
    const straight = layout.edges.find((edge) => edge.transition.id === 'plan-impl')
    expect(straight?.kind).toBe('forward')
  })
})
