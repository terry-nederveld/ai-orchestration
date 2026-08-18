/**
 * Declarative work-item → repository mapping (mission §8): many-to-many
 * rules with deterministic precedence. Resolution paths, in order:
 * explicit item metadata, rule-based mapping, agent-assisted discovery
 * (fallback, recorded as such in the execution specification).
 */

import type { RepositoryRole } from './execution-spec.js'
import type { RepositoryReference, WorkItem } from './work.js'

export type MappingConditionOperator = 'equals' | 'in' | 'contains' | 'regex'

export interface MappingCondition {
  /**
   * Dotted field path over the work item: `provider`, `type`, `state`,
   * `labels`, `metadata.<key>`, `parent.<field>`, `relationships.<kind>`.
   */
  readonly field: string
  readonly operator: MappingConditionOperator
  readonly value: string | readonly string[]
}

export type MappingPredicate =
  | { readonly all: readonly MappingPredicate[] }
  | { readonly any: readonly MappingPredicate[] }
  | { readonly not: MappingPredicate }
  | { readonly condition: MappingCondition }

export interface MappingRule {
  readonly id: string
  /** Higher wins on conflict; ties broken by declaration order. */
  readonly priority: number
  readonly when: MappingPredicate
  readonly repositories: ReadonlyArray<{
    readonly repository: RepositoryReference
    readonly role: RepositoryRole
  }>
  /** 'replace' discards lower-priority matches; 'merge' unions them. */
  readonly onConflict?: 'replace' | 'merge'
}

export interface MappingRuleSet {
  readonly name: string
  readonly rules: readonly MappingRule[]
}

export interface ResolvedRepository {
  readonly repository: RepositoryReference
  readonly role: RepositoryRole
  readonly resolvedBy: string
}

/** Evaluate a predicate against a work item (plus optional parent). */
export function evaluatePredicate(
  predicate: MappingPredicate,
  item: WorkItem,
  parent?: WorkItem,
): boolean {
  if ('all' in predicate) return predicate.all.every((p) => evaluatePredicate(p, item, parent))
  if ('any' in predicate) return predicate.any.some((p) => evaluatePredicate(p, item, parent))
  if ('not' in predicate) return !evaluatePredicate(predicate.not, item, parent)
  return evaluateCondition(predicate.condition, item, parent)
}

function evaluateCondition(
  condition: MappingCondition,
  item: WorkItem,
  parent?: WorkItem,
): boolean {
  const values = fieldValues(condition.field, item, parent)
  const expected = condition.value
  switch (condition.operator) {
    case 'equals':
      return values.some((value) => value === expected)
    case 'in':
      return values.some((value) => Array.isArray(expected) && expected.includes(value))
    case 'contains':
      return values.some(
        (value) =>
          typeof expected === 'string' && value.toLowerCase().includes(expected.toLowerCase()),
      )
    case 'regex': {
      if (typeof expected !== 'string') return false
      let pattern: RegExp
      try {
        pattern = new RegExp(expected)
      } catch {
        return false
      }
      return values.some((value) => pattern.test(value))
    }
  }
}

function fieldValues(field: string, item: WorkItem, parent?: WorkItem): readonly string[] {
  if (field.startsWith('parent.')) {
    return parent ? fieldValues(field.slice('parent.'.length), parent) : []
  }
  if (field.startsWith('relationships.')) {
    const kind = field.slice('relationships.'.length)
    return item.relationships
      .filter((relationship) => relationship.kind === kind)
      .map((relationship) => relationship.targetExternalId)
  }
  if (field.startsWith('metadata.')) {
    const value = item.metadata[field.slice('metadata.'.length)]
    if (typeof value === 'string') return [value]
    if (Array.isArray(value))
      return value.filter((entry): entry is string => typeof entry === 'string')
    return value === undefined || value === null ? [] : [String(value)]
  }
  switch (field) {
    case 'provider':
      return [item.provider]
    case 'externalId':
      return [item.externalId]
    case 'title':
      return [item.title]
    case 'state':
      return [item.state]
    case 'type':
      return item.type !== undefined ? [item.type] : []
    case 'priority':
      return item.priority !== undefined ? [item.priority] : []
    case 'labels':
      return item.labels
    default:
      return []
  }
}

/**
 * Resolve repositories for an item through a rule set. Deterministic:
 * rules sorted by priority desc then declaration order; a 'replace' match
 * discards everything below it; 'merge' (default) unions by locator+role.
 */
export function resolveRepositories(
  ruleSet: MappingRuleSet,
  item: WorkItem,
  parent?: WorkItem,
): readonly ResolvedRepository[] {
  const ordered = ruleSet.rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index)

  const resolved = new Map<string, ResolvedRepository>()
  for (const { rule } of ordered) {
    if (!evaluatePredicate(rule.when, item, parent)) continue
    for (const entry of rule.repositories) {
      const key = `${entry.repository.locator}#${entry.role}`
      if (!resolved.has(key)) {
        resolved.set(key, { ...entry, resolvedBy: `rule:${rule.id}` })
      }
    }
    // A matching 'replace' rule contributes and discards everything below.
    if (rule.onConflict === 'replace') break
  }
  return [...resolved.values()]
}
