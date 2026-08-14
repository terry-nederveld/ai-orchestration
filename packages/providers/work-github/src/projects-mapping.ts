/** Maps GitHub GraphQL Projects v2 item payloads onto the canonical WorkItem shape. */

import { asId, type WorkItem } from '@overture/core'
import type { ProjectV2Item } from './graphql-types.js'

const PROVIDER_ID = 'github-projects'

function extractStatus(item: ProjectV2Item, statusFieldName: string): string | undefined {
  for (const fieldValue of item.fieldValues.nodes) {
    if (fieldValue.field?.name === statusFieldName && fieldValue.name) return fieldValue.name
  }
  return undefined
}

export function projectItemToWorkItem(item: ProjectV2Item, statusFieldName: string): WorkItem {
  const state = extractStatus(item, statusFieldName) ?? 'no-status'
  const content = item.content
  const id = asId<'work-item'>(`${PROVIDER_ID}:${item.id}`)

  if (!content) {
    // Content the token can't see (e.g. a PR in a private repo without access) or a
    // content type we don't model. Surface the item shell so discover() doesn't drop it silently.
    return {
      id,
      provider: PROVIDER_ID,
      externalId: item.id,
      title: '(inaccessible or unsupported item)',
      state,
      type: 'unknown',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: { projectItemId: item.id },
    }
  }

  if (content.__typename === 'DraftIssue') {
    return {
      id,
      provider: PROVIDER_ID,
      externalId: item.id,
      title: content.title,
      ...(content.body ? { description: content.body } : {}),
      state,
      type: 'draft',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: { projectItemId: item.id },
    }
  }

  const repository = content.repository
    ? {
        locator: content.repository.nameWithOwner,
        ...(content.repository.defaultBranchRef?.name
          ? { defaultBranch: content.repository.defaultBranchRef.name }
          : {}),
      }
    : undefined

  return {
    id,
    provider: PROVIDER_ID,
    externalId: item.id,
    title: content.title,
    ...(content.body ? { description: content.body } : {}),
    state,
    type: 'issue',
    labels: content.labels?.nodes.map((l) => l.name) ?? [],
    assignees: content.assignees?.nodes.map((a) => ({ id: a.login, displayName: a.login })) ?? [],
    relationships: [],
    ...(repository ? { repository } : {}),
    metadata: { projectItemId: item.id, contentNodeId: content.id, number: content.number },
    url: content.url,
  }
}

/** Reads the underlying issue's GraphQL node id off a mapped WorkItem, if any (absent for drafts). */
export function contentNodeIdOf(item: WorkItem): string | undefined {
  const value = item.metadata.contentNodeId
  return typeof value === 'string' ? value : undefined
}
