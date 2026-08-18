/** Minimal shapes for the GitHub REST API responses this package consumes. */

export interface GitHubUser {
  readonly login: string
  readonly id: number
}

export interface GitHubLabel {
  readonly name: string
}

export interface GitHubIssue {
  /** Database id, required by the sub-issues endpoints (absent in some older fixtures). */
  readonly id?: number
  readonly number: number
  readonly node_id: string
  readonly title: string
  readonly body: string | null
  readonly state: 'open' | 'closed'
  readonly labels: readonly (string | GitHubLabel)[]
  readonly assignees?: readonly GitHubUser[] | null
  readonly html_url: string
  readonly updated_at?: string
  /** Present (and truthy) only when the "issue" is actually a pull request. */
  readonly pull_request?: unknown
}

export interface GitHubComment {
  readonly id: number
  readonly body: string
  readonly created_at: string
}
