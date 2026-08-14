/** Maps Linear GraphQL issue/state shapes onto the canonical WorkItem. */

import { asId, type Identity, type WorkItem, type WorkStateInfo } from '@overture/core'
import type { LinearIssue, LinearWorkflowState } from './linear-types.js'

/** Linear priority: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low. */
const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
}

export function mapPriority(priority: number): string {
  return PRIORITY_NAMES[priority] ?? 'none'
}

type StateCategory = NonNullable<WorkStateInfo['category']>

/** Linear workflow state types: triage/backlog/unstarted/started/completed/canceled. */
export function mapStateCategory(type: string): StateCategory {
  switch (type) {
    case 'unstarted':
    case 'backlog':
    case 'triage':
      return 'todo'
    case 'started':
      return 'in-progress'
    case 'completed':
      return 'done'
    default:
      return 'other'
  }
}

/**
 * `id` is the state's name rather than Linear's internal state id: WorkItem.state
 * is also the state name (see mapIssueToWorkItem), and WorkStateInfo.id is the
 * identifier callers pass back into transition()'s targetState, so the two must
 * share a value space. The internal Linear state id is resolved separately at
 * mutation time via the team's states list.
 */
export function stateToStateInfo(state: LinearWorkflowState): WorkStateInfo {
  return { id: state.name, name: state.name, category: mapStateCategory(state.type) }
}

export function mapIssueToWorkItem(issue: LinearIssue): WorkItem {
  const assignees: Identity[] = issue.assignee
    ? [{ id: issue.assignee.id, displayName: issue.assignee.name }]
    : []

  return {
    id: asId<'work-item'>(`linear:${issue.identifier}`),
    provider: 'linear',
    externalId: issue.identifier,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    state: issue.state.name,
    priority: mapPriority(issue.priority),
    labels: issue.labels.nodes.map((label) => label.name),
    assignees,
    relationships: [],
    metadata: {
      linearId: issue.id,
      stateType: issue.state.type,
      labelIds: issue.labels.nodes.map((label) => label.id),
      ...(issue.team ? { teamKey: issue.team.key } : {}),
    },
    url: issue.url,
    updatedAt: new Date(issue.updatedAt),
  }
}
