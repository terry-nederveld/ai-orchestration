/**
 * Maps Jira Data Center REST API v2 issue shapes onto the canonical
 * WorkItem. Description and comment bodies are plain strings — never ADF.
 */

import { asId, type WorkItem, type WorkStateInfo } from '@overture/core'
import type { JiraIssue, JiraStatus } from './jira-types.js'

export const SEARCH_FIELDS = 'summary,description,status,issuetype,priority,labels,assignee,updated'

export function mapStatusCategory(key: string | undefined): NonNullable<WorkStateInfo['category']> {
  switch (key) {
    case 'new':
      return 'todo'
    case 'indeterminate':
      return 'in-progress'
    case 'done':
      return 'done'
    default:
      return 'other'
  }
}

export function statusToStateInfo(status: JiraStatus): WorkStateInfo {
  return {
    id: status.id,
    name: status.name,
    category: mapStatusCategory(status.statusCategory?.key),
  }
}

export function mapIssueToWorkItem(issue: JiraIssue, baseUrl: string): WorkItem {
  const fields = issue.fields
  const description = fields.description ?? undefined
  const assigneeId = fields.assignee?.name ?? fields.assignee?.key
  return {
    id: asId<'work-item'>(`jira-datacenter:${issue.key}`),
    provider: 'jira-datacenter',
    externalId: issue.key,
    title: fields.summary,
    ...(description ? { description } : {}),
    state: fields.status.name,
    ...(fields.issuetype?.name !== undefined ? { type: fields.issuetype.name } : {}),
    ...(fields.priority?.name !== undefined ? { priority: fields.priority.name } : {}),
    labels: fields.labels ?? [],
    assignees:
      fields.assignee && assigneeId
        ? [
            {
              id: assigneeId,
              ...(fields.assignee.displayName !== undefined
                ? { displayName: fields.assignee.displayName }
                : {}),
              ...(fields.assignee.emailAddress !== undefined
                ? { email: fields.assignee.emailAddress }
                : {}),
            },
          ]
        : [],
    relationships: [],
    metadata: {},
    url: `${baseUrl}/browse/${issue.key}`,
    ...(fields.updated !== undefined ? { updatedAt: new Date(fields.updated) } : {}),
  }
}
