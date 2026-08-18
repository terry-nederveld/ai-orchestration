/**
 * Structural validation for workflow graphs: referential integrity,
 * reachability, terminal coverage, and the bounded-cycle rule (every
 * transition participating in a cycle must declare a loopBound).
 */

import type { WorkflowGraph } from './graph.js'

export interface GraphIssue {
  readonly path: string
  readonly message: string
}

export function validateGraph(graph: WorkflowGraph): readonly GraphIssue[] {
  const issues: GraphIssue[] = []
  const nodeIds = new Set<string>()

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ path: `nodes.${node.id}`, message: 'duplicate node id' })
    }
    nodeIds.add(node.id)
  }

  if (!nodeIds.has(graph.entry)) {
    issues.push({ path: 'entry', message: `entry node '${graph.entry}' does not exist` })
  }

  const transitionIds = new Set<string>()
  for (const transition of graph.transitions) {
    if (transitionIds.has(transition.id)) {
      issues.push({ path: `transitions.${transition.id}`, message: 'duplicate transition id' })
    }
    transitionIds.add(transition.id)
    if (!nodeIds.has(transition.from)) {
      issues.push({
        path: `transitions.${transition.id}`,
        message: `unknown source node '${transition.from}'`,
      })
    }
    if (!nodeIds.has(transition.to)) {
      issues.push({
        path: `transitions.${transition.id}`,
        message: `unknown target node '${transition.to}'`,
      })
    }
    if (transition.loopBound !== undefined && transition.loopBound < 1) {
      issues.push({
        path: `transitions.${transition.id}`,
        message: 'loopBound must be at least 1',
      })
    }
  }
  if (issues.length > 0) return issues

  // Reachability from entry.
  const outgoing = new Map<string, string[]>()
  for (const transition of graph.transitions) {
    const list = outgoing.get(transition.from) ?? []
    list.push(transition.to)
    outgoing.set(transition.from, list)
  }
  const reachable = new Set<string>()
  const queue = [graph.entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || reachable.has(current)) continue
    reachable.add(current)
    for (const next of outgoing.get(current) ?? []) queue.push(next)
  }
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ path: `nodes.${node.id}`, message: 'unreachable from entry' })
    }
  }

  // Terminal coverage: at least one reachable terminal node.
  const hasTerminal = graph.nodes.some(
    (node) => node.config.kind === 'terminal' && reachable.has(node.id),
  )
  if (!hasTerminal) {
    issues.push({ path: 'nodes', message: 'no reachable terminal node' })
  }

  // Terminal nodes must not have outgoing transitions.
  for (const node of graph.nodes) {
    if (node.config.kind === 'terminal' && (outgoing.get(node.id) ?? []).length > 0) {
      issues.push({
        path: `nodes.${node.id}`,
        message: 'terminal node must not have outgoing transitions',
      })
    }
  }

  // Join rule: 'all'/'min' joins are forbidden inside cycles (activation
  // counting would be ambiguous across loop rounds).
  for (const node of graph.nodes) {
    const inCycle = (outgoing.get(node.id) ?? []).some((next) =>
      reachesBack(next, node.id, outgoing),
    )
    if (node.join && node.join.mode !== 'any' && inCycle) {
      issues.push({
        path: `nodes.${node.id}`,
        message: `'${node.join.mode}' join is not allowed on a node inside a cycle`,
      })
    }
    if (node.join?.mode === 'min' && (node.join.n === undefined || node.join.n < 1)) {
      issues.push({ path: `nodes.${node.id}`, message: "'min' join requires n >= 1" })
    }
  }

  // Bounded-cycle rule: every transition on a cycle needs a loopBound.
  for (const transition of graph.transitions) {
    if (transition.loopBound !== undefined) continue
    if (reachesBack(transition.to, transition.from, outgoing)) {
      issues.push({
        path: `transitions.${transition.id}`,
        message: 'transition participates in a cycle and must declare loopBound',
      })
    }
  }

  return issues
}

/** True when `from` can reach `target` following outgoing transitions. */
function reachesBack(
  from: string,
  target: string,
  outgoing: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) continue
    if (current === target) return true
    seen.add(current)
    for (const next of outgoing.get(current) ?? []) queue.push(next)
  }
  return false
}
