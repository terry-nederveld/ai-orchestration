/** Raw shapes returned by the Linear GraphQL API, scoped to the fields we request. */

export interface LinearUser {
  readonly id: string
  readonly name: string
}

export interface LinearWorkflowState {
  readonly id: string
  readonly name: string
  readonly type: string
}

export interface LinearLabel {
  readonly id: string
  readonly name: string
}

export interface LinearIssue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly description: string | null
  readonly state: { readonly name: string; readonly type: string }
  readonly labels: { readonly nodes: readonly LinearLabel[] }
  readonly assignee: LinearUser | null
  readonly priority: number
  readonly url: string
  readonly updatedAt: string
  readonly team: { readonly key: string } | null
}

/** Snapshot used to make an authoritative claim/release decision. */
export interface LinearIssueClaimState {
  readonly id: string
  readonly labels: { readonly nodes: readonly LinearLabel[] }
  readonly comments: { readonly nodes: readonly { readonly body: string }[] }
}

export interface LinearTeam {
  readonly id: string
  readonly states: { readonly nodes: readonly LinearWorkflowState[] }
  readonly labels: { readonly nodes: readonly LinearLabel[] }
}

/** GraphQL filter object accepted by `issues(filter: ...)`. */
export interface LinearIssueFilter {
  readonly team?: { readonly key: { readonly eq: string } }
  readonly state?: { readonly name: { readonly in: readonly string[] } }
  readonly assignee?: { readonly null: true } | { readonly id: { readonly eq: string } }
  readonly labels?: {
    readonly some?: { readonly name: { readonly in: readonly string[] } }
    readonly every?: { readonly name: { readonly nin: readonly string[] } }
  }
  readonly and?: readonly LinearIssueFilter[]
}

export interface GraphQLError {
  readonly message: string
  readonly extensions?: { readonly code?: string }
}

export interface GraphQLResponse<T> {
  readonly data?: T
  readonly errors?: readonly GraphQLError[]
}
