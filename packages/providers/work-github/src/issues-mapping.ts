/** Maps GitHub REST issue payloads onto the canonical WorkItem shape. */

import { asId, type Identity, type RepositoryReference, type WorkItem } from '@overture/core'
import type { GitHubIssue, GitHubLabel } from './rest-types.js'

export function labelName(label: string | GitHubLabel): string {
  return typeof label === 'string' ? label : label.name
}

/**
 * Native GitHub issues only have open/closed. Richer workflow states are
 * modeled as mutually-exclusive labels via the `stateLabels` map (workflow
 * state name -> label). A closed issue is always reported as "closed"
 * regardless of any state label left on it.
 */
export function resolveIssueState(
  issue: GitHubIssue,
  stateLabels: Readonly<Record<string, string>>,
): string {
  if (issue.state === 'closed') return 'closed'
  const labelNames = new Set(issue.labels.map(labelName))
  for (const [stateName, label] of Object.entries(stateLabels)) {
    if (labelNames.has(label)) return stateName
  }
  return 'open'
}

export function issueToWorkItem(
  issue: GitHubIssue,
  repo: string,
  defaultBranch: string | undefined,
  stateLabels: Readonly<Record<string, string>>,
): WorkItem {
  const assignees: Identity[] = (issue.assignees ?? []).map((a) => ({
    id: a.login,
    displayName: a.login,
  }))
  const repository: RepositoryReference = {
    locator: repo,
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
  }

  return {
    id: asId<'work-item'>(`github:${repo}#${issue.number}`),
    provider: 'github',
    externalId: String(issue.number),
    title: issue.title,
    ...(issue.body ? { description: issue.body } : {}),
    state: resolveIssueState(issue, stateLabels),
    labels: issue.labels.map(labelName),
    assignees,
    relationships: [],
    repository,
    metadata: { number: issue.number, nodeId: issue.node_id },
    url: issue.html_url,
    ...(issue.updated_at ? { updatedAt: new Date(issue.updated_at) } : {}),
  }
}

/** True for REST issue-list entries that are actually pull requests. */
export function isPullRequest(issue: GitHubIssue): boolean {
  return issue.pull_request !== undefined
}

/** Extracts the `rel="next"` URL from a GitHub `Link` response header, if present. */
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (match?.[1]) return match[1]
  }
  return undefined
}
