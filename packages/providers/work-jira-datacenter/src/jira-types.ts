/**
 * Minimal Jira Data Center REST API v2 response shapes used by this adapter.
 * Unlike Cloud, rich text is plain string / wiki-markup — never ADF.
 */

export interface JiraUser {
  readonly name?: string
  readonly key?: string
  readonly displayName?: string
  readonly emailAddress?: string
}

export interface JiraStatusCategory {
  readonly key: string
}

export interface JiraStatus {
  readonly id: string
  readonly name: string
  readonly statusCategory?: JiraStatusCategory
}

export interface JiraIssueFields {
  readonly summary: string
  readonly description?: string | null
  readonly status: JiraStatus
  readonly issuetype?: { readonly name: string }
  readonly priority?: { readonly name: string }
  readonly labels?: readonly string[]
  readonly assignee?: JiraUser | null
  readonly updated?: string
}

export interface JiraIssue {
  readonly key: string
  readonly fields: JiraIssueFields
}

export interface JiraSearchResponse {
  readonly issues: readonly JiraIssue[]
  readonly startAt: number
  readonly maxResults: number
  readonly total: number
}

export interface JiraTransition {
  readonly id: string
  readonly name: string
  readonly to?: { readonly name?: string }
}

export interface JiraTransitionsResponse {
  readonly transitions: readonly JiraTransition[]
}

export interface JiraProjectStatusesEntry {
  readonly name: string
  readonly statuses: readonly JiraStatus[]
}
