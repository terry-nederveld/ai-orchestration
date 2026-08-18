/**
 * GraphQL documents sent to Linear's single `/graphql` endpoint, plus the
 * WorkQuery -> IssueFilter translation. Operation names are distinct
 * (`query Viewer`, `mutation IssueUpdate`, ...) so tests can route fake
 * responses by matching on the operation name in the request body.
 */

import type { WorkQuery } from '@overture/core'
import type { LinearIssueFilter } from './linear-types.js'

export const VIEWER_QUERY = `
  query Viewer {
    viewer {
      id
      name
    }
  }
`

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  state { name type }
  labels { nodes { id name } }
  assignee { id name }
  priority
  url
  updatedAt
  team { key }
`

export const ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
`

export const ISSUE_GET_QUERY = `
  query IssueGet($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
    }
  }
`

/** Fresh description fetch for getDescription(); deliberately narrow so it stays cheap. */
export const ISSUE_DESCRIPTION_QUERY = `
  query IssueDescription($id: String!) {
    issue(id: $id) {
      id
      description
    }
  }
`

/** Authoritative snapshot for claim()/release(): current claim label and the latest marker comment. */
export const ISSUE_CLAIM_STATE_QUERY = `
  query IssueClaimState($id: String!) {
    issue(id: $id) {
      id
      labels { nodes { id name } }
      comments(last: 1) {
        nodes { body }
      }
    }
  }
`

export const TEAM_QUERY = `
  query Team($teamKey: String!) {
    team(key: $teamKey) {
      id
      states { nodes { id name type } }
      labels { nodes { id name } }
    }
  }
`

export const ISSUE_LABEL_CREATE_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name }
    }
  }
`

export const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        state { name type }
        labels { nodes { id name } }
      }
    }
  }
`

export const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body }
    }
  }
`

/**
 * Builds the `issues(filter: ...)` variable from a provider-neutral WorkQuery.
 * `labelsInclude` maps to `labels: { some: { name: { in } } }` and
 * `labelsExclude` to `labels: { every: { name: { nin } } }`; when both are
 * present they're combined under `and` since they'd otherwise collide on the
 * same `labels` key.
 */
export function buildIssueFilter(
  query: WorkQuery,
  teamKey: string | undefined,
): LinearIssueFilter | undefined {
  const filter: Record<string, unknown> = {}
  if (teamKey) filter.team = { key: { eq: teamKey } }
  if (query.states && query.states.length > 0) {
    filter.state = { name: { in: [...query.states] } }
  }
  if (query.assignee === 'unassigned') {
    filter.assignee = { null: true }
  } else if (query.assignee) {
    filter.assignee = { id: { eq: query.assignee } }
  }

  const include = query.labelsInclude ?? []
  const exclude = query.labelsExclude ?? []
  if (include.length > 0 && exclude.length > 0) {
    filter.and = [
      { labels: { some: { name: { in: [...include] } } } },
      { labels: { every: { name: { nin: [...exclude] } } } },
    ]
  } else if (include.length > 0) {
    filter.labels = { some: { name: { in: [...include] } } }
  } else if (exclude.length > 0) {
    filter.labels = { every: { name: { nin: [...exclude] } } }
  }

  return Object.keys(filter).length > 0 ? (filter as LinearIssueFilter) : undefined
}
