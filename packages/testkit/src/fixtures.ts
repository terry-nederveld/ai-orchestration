/**
 * Small fixture builders for domain types used across fakes and contract
 * suites. Keep these minimal — they exist to make test setup terse, not to
 * encode business rules.
 */

import { asId, type WorkItem } from '@overture/core'

let workItemSeq = 0

/** Builds a WorkItem with sensible defaults, overridable per field. */
export function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  workItemSeq += 1
  const provider = overrides.provider ?? 'fake'
  const externalId = overrides.externalId ?? `ITEM-${workItemSeq}`
  return {
    id: overrides.id ?? asId(`${provider}:${externalId}`),
    provider,
    externalId,
    title: overrides.title ?? `Fixture item ${workItemSeq}`,
    state: overrides.state ?? 'todo',
    labels: overrides.labels ?? [],
    assignees: overrides.assignees ?? [],
    relationships: overrides.relationships ?? [],
    metadata: overrides.metadata ?? {},
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
    ...(overrides.repository !== undefined ? { repository: overrides.repository } : {}),
    ...(overrides.url !== undefined ? { url: overrides.url } : {}),
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
  }
}

/** Resets fixture sequence counters. Call between tests when ids must be stable. */
export function resetFixtureSequences(): void {
  workItemSeq = 0
}
