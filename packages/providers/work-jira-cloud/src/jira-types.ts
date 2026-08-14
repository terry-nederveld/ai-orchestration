/** Minimal Jira Cloud REST API v3 response shapes used by this adapter. */

export interface AdfTextNode {
  readonly type: 'text'
  readonly text: string
}

export interface AdfNode {
  readonly type: string
  readonly text?: string
  readonly content?: readonly AdfNode[]
  readonly attrs?: Readonly<Record<string, unknown>>
}

export interface AdfDoc {
  readonly type: 'doc'
  readonly version: 1
  readonly content: readonly AdfNode[]
}

export interface JiraUser {
  readonly accountId: string
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
  readonly description?: AdfDoc | null
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
  readonly nextPageToken?: string
  readonly isLast?: boolean
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
