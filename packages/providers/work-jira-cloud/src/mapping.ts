/** Maps Jira Cloud REST API v3 issue shapes onto the canonical WorkItem. */

import { asId, type WorkItem, type WorkStateInfo } from '@overture/core'
import { adfToText } from './adf.js'
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

export function mapIssueToWorkItem(issue: JiraIssue, siteHost: string): WorkItem {
  const fields = issue.fields
  const description = adfToText(fields.description)
  return {
    id: asId<'work-item'>(`jira-cloud:${issue.key}`),
    provider: 'jira-cloud',
    externalId: issue.key,
    title: fields.summary,
    ...(description ? { description } : {}),
    state: fields.status.name,
    ...(fields.issuetype?.name !== undefined ? { type: fields.issuetype.name } : {}),
    ...(fields.priority?.name !== undefined ? { priority: fields.priority.name } : {}),
    labels: fields.labels ?? [],
    assignees: fields.assignee
      ? [
          {
            id: fields.assignee.accountId,
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
    url: `https://${siteHost}/browse/${issue.key}`,
    ...(fields.updated !== undefined ? { updatedAt: new Date(fields.updated) } : {}),
  }
}
