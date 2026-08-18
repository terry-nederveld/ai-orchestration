/**
 * Layered DAG layout for the workflow graph canvas. Pure geometry: layers
 * are longest-path depths from the entry over forward transitions; edges
 * that close a cycle (or point at an ancestor on the DFS stack) are routed
 * separately as dashed back-edges so loops read as loops.
 */

import type { GraphNodeDoc, GraphTransitionDoc, WorkflowGraphDoc } from './types'

export const NODE_WIDTH = 176
export const NODE_HEIGHT = 58
const H_GAP = 40
const V_GAP = 64
const MARGIN = 28
const BACK_LANE_GAP = 28

export type EdgeKind = 'forward' | 'back' | 'self'

export interface PlacedNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly node: GraphNodeDoc
}

export interface PlacedEdge {
  readonly transition: GraphTransitionDoc
  readonly kind: EdgeKind
  /** SVG path data from source anchor to target anchor. */
  readonly path: string
  readonly labelX: number
  readonly labelY: number
}

export interface GraphLayout {
  readonly nodes: readonly PlacedNode[]
  readonly edges: readonly PlacedEdge[]
  readonly width: number
  readonly height: number
}

export function layoutGraph(graph: WorkflowGraphDoc): GraphLayout {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((n) => Boolean(n?.id)) : []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const transitions = Array.isArray(graph.transitions)
    ? graph.transitions.filter((t) => t && nodeIds.has(t.from) && nodeIds.has(t.to))
    : []

  const outgoing = new Map<string, GraphTransitionDoc[]>()
  for (const transition of transitions) {
    outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), transition])
  }

  // DFS edge classification: an edge into a node still on the stack (or
  // into itself) is a back edge; everything else is forward.
  const backEdges = new Set<string>()
  const state = new Map<string, 'active' | 'done'>()
  const visit = (id: string): void => {
    state.set(id, 'active')
    for (const transition of outgoing.get(id) ?? []) {
      if (transition.to === id) {
        backEdges.add(transition.id)
        continue
      }
      const targetState = state.get(transition.to)
      if (targetState === 'active') backEdges.add(transition.id)
      else if (targetState === undefined) visit(transition.to)
    }
    state.set(id, 'done')
  }
  if (nodeIds.has(graph.entry)) visit(graph.entry)
  for (const node of nodes) {
    if (!state.has(node.id)) visit(node.id)
  }

  // Longest-path layering over the forward-edge DAG (Kahn order).
  const forward = transitions.filter((t) => !backEdges.has(t.id))
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]))
  for (const transition of forward) {
    indegree.set(transition.to, (indegree.get(transition.to) ?? 0) + 1)
  }
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]))
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const transition of forward.filter((t) => t.from === id)) {
      layer.set(transition.to, Math.max(layer.get(transition.to) ?? 0, (layer.get(id) ?? 0) + 1))
      const remaining = (indegree.get(transition.to) ?? 0) - 1
      indegree.set(transition.to, remaining)
      if (remaining === 0) queue.push(transition.to)
    }
  }

  // Rows: declaration order within a layer keeps related nodes adjacent.
  const rows = new Map<number, GraphNodeDoc[]>()
  for (const node of nodes) {
    const depth = layer.get(node.id) ?? 0
    rows.set(depth, [...(rows.get(depth) ?? []), node])
  }
  const maxPerRow = Math.max(1, ...[...rows.values()].map((row) => row.length))
  const coreWidth = MARGIN * 2 + maxPerRow * NODE_WIDTH + (maxPerRow - 1) * H_GAP
  const backCount = transitions.length - forward.length
  const width = coreWidth + (backCount > 0 ? MARGIN + backCount * BACK_LANE_GAP : 0)
  const rowCount = rows.size === 0 ? 0 : Math.max(...rows.keys()) + 1
  const height = MARGIN * 2 + rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * V_GAP

  const placed = new Map<string, PlacedNode>()
  for (const [depth, row] of rows) {
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * H_GAP
    const startX = MARGIN + (coreWidth - MARGIN * 2 - rowWidth) / 2
    row.forEach((node, index) => {
      placed.set(node.id, {
        id: node.id,
        x: startX + index * (NODE_WIDTH + H_GAP),
        y: MARGIN + depth * (NODE_HEIGHT + V_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        node,
      })
    })
  }

  // Spread multiple outgoing/incoming forward anchors across node borders.
  const outIndex = anchorIndexes(forward, (t) => t.from)
  const inIndex = anchorIndexes(forward, (t) => t.to)

  const edges: PlacedEdge[] = []
  let backLane = 0
  for (const transition of transitions) {
    const source = placed.get(transition.from)
    const target = placed.get(transition.to)
    if (!source || !target) continue
    if (transition.id !== undefined && backEdges.has(transition.id)) {
      if (transition.from === transition.to) {
        const x = source.x + source.width
        const y = source.y + source.height / 2
        edges.push({
          transition,
          kind: 'self',
          path: `M ${x} ${y - 10} C ${x + 44} ${y - 22}, ${x + 44} ${y + 22}, ${x} ${y + 10}`,
          labelX: x + 50,
          labelY: y,
        })
        continue
      }
      backLane += 1
      const laneX = coreWidth - MARGIN / 2 + backLane * BACK_LANE_GAP
      const sy = source.y + source.height / 2
      const ty = target.y + target.height / 2
      edges.push({
        transition,
        kind: 'back',
        path: `M ${source.x + source.width} ${sy} C ${laneX} ${sy}, ${laneX} ${ty}, ${
          target.x + target.width
        } ${ty}`,
        labelX: laneX,
        labelY: (sy + ty) / 2,
      })
      continue
    }
    const outs = outIndex.get(transition.id) ?? { index: 0, count: 1 }
    const ins = inIndex.get(transition.id) ?? { index: 0, count: 1 }
    const sx = source.x + (source.width * (outs.index + 1)) / (outs.count + 1)
    const sy = source.y + source.height
    const tx = target.x + (target.width * (ins.index + 1)) / (ins.count + 1)
    const ty = target.y
    const my = (sy + ty) / 2
    edges.push({
      transition,
      kind: 'forward',
      path: `M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`,
      labelX: (sx + tx) / 2,
      labelY: my,
    })
  }

  return { nodes: [...placed.values()], edges, width, height }
}

function anchorIndexes(
  transitions: readonly GraphTransitionDoc[],
  key: (t: GraphTransitionDoc) => string,
): Map<string, { index: number; count: number }> {
  const grouped = new Map<string, GraphTransitionDoc[]>()
  for (const transition of transitions) {
    grouped.set(key(transition), [...(grouped.get(key(transition)) ?? []), transition])
  }
  const result = new Map<string, { index: number; count: number }>()
  for (const group of grouped.values()) {
    group.forEach((transition, index) => {
      result.set(transition.id, { index, count: group.length })
    })
  }
  return result
}
