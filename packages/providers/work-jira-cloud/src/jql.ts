/**
 * Translates a provider-neutral WorkQuery into a JQL string. `nativeQuery`
 * is an escape hatch that overrides construction entirely.
 */

import type { WorkQuery } from '@overture/core'

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildJql(query: WorkQuery, defaultProjectKey?: string): string {
  if (query.nativeQuery) return query.nativeQuery

  const clauses: string[] = []
  const container = query.container ?? defaultProjectKey
  if (container) clauses.push(`project = ${jqlString(container)}`)

  if (query.states && query.states.length > 0) {
    clauses.push(`status IN (${query.states.map(jqlString).join(', ')})`)
  }

  if (query.labelsInclude) {
    for (const label of query.labelsInclude) clauses.push(`labels = ${jqlString(label)}`)
  }

  if (query.labelsExclude && query.labelsExclude.length > 0) {
    const excluded = query.labelsExclude.map(jqlString).join(', ')
    clauses.push(`(labels IS EMPTY OR labels NOT IN (${excluded}))`)
  }

  if (query.assignee) {
    clauses.push(
      query.assignee === 'unassigned'
        ? 'assignee IS EMPTY'
        : `assignee = ${jqlString(query.assignee)}`,
    )
  }

  const where = clauses.join(' AND ')
  return where ? `${where} ORDER BY updated DESC` : 'ORDER BY updated DESC'
}
