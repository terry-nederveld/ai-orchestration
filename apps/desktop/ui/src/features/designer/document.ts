/**
 * Helpers over the canonical workflow graph document: display summaries
 * for the canvas, and immutable field updates used by the inspector so
 * every edit flows back into the one document the YAML view also shows.
 */

import type { GraphNodeDoc, GraphTransitionDoc, WorkflowGraphDoc } from './types'

export const NODE_KIND_ICONS: Readonly<Record<string, string>> = {
  agent: 'A',
  command: '$',
  action: '⚡',
  gate: '✓',
  'human-input': 'H',
  wait: 'W',
  subworkflow: 'S',
  experiment: 'E',
  'fan-out': 'F',
  terminal: '◼',
}

export function nodeKindIcon(kind: string): string {
  return NODE_KIND_ICONS[kind] ?? '?'
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function refName(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name
    if (typeof name === 'string') return name
  }
  return ''
}

/** The one-line config summary shown inside a canvas node. */
export function nodeSummary(node: GraphNodeDoc): string {
  const config = node.config
  switch (config.kind) {
    case 'agent':
      return typeof config.goal === 'string' ? config.goal : ''
    case 'command':
      return typeof config.command === 'string' ? config.command : ''
    case 'action':
      return typeof config.action === 'string' ? config.action : ''
    case 'gate':
      return refName(config.gateSet)
    case 'subworkflow':
    case 'fan-out':
      return refName(config.workflow)
    case 'experiment':
      return refName(config.experiment)
    case 'human-input': {
      const request = config.request
      if (request !== null && typeof request === 'object') {
        const prompt = (request as Record<string, unknown>).prompt
        if (typeof prompt === 'string') return prompt
      }
      return ''
    }
    case 'wait': {
      const condition = config.condition
      if (condition !== null && typeof condition === 'object') {
        const kind = (condition as Record<string, unknown>).kind
        if (typeof kind === 'string') return kind
      }
      return ''
    }
    case 'terminal':
      return typeof config.outcome === 'string' ? config.outcome : ''
    default:
      return ''
  }
}

/** Short edge label: truncated condition plus the loop bound when set. */
export function transitionLabel(transition: GraphTransitionDoc): string {
  const parts: string[] = []
  if (transition.condition) parts.push(truncate(transition.condition, 26))
  if (transition.loopBound !== undefined) parts.push(`⟲${transition.loopBound}`)
  return parts.join('  ')
}

export function findNode(doc: WorkflowGraphDoc, nodeId: string): GraphNodeDoc | undefined {
  return doc.nodes.find((node) => node.id === nodeId)
}

export function findTransition(
  doc: WorkflowGraphDoc,
  transitionId: string,
): GraphTransitionDoc | undefined {
  return doc.transitions.find((transition) => transition.id === transitionId)
}

export function replaceNodeConfig(
  doc: WorkflowGraphDoc,
  nodeId: string,
  config: GraphNodeDoc['config'],
): WorkflowGraphDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
  }
}

export function updateTransitionFields(
  doc: WorkflowGraphDoc,
  transitionId: string,
  fields: { readonly condition?: string; readonly loopBound?: number },
): WorkflowGraphDoc {
  return {
    ...doc,
    transitions: doc.transitions.map((transition) => {
      if (transition.id !== transitionId) return transition
      const next: Record<string, unknown> = { ...transition }
      if (fields.condition === undefined || fields.condition === '') delete next.condition
      else next.condition = fields.condition
      if (fields.loopBound === undefined) delete next.loopBound
      else next.loopBound = fields.loopBound
      return next as unknown as GraphTransitionDoc
    }),
  }
}
