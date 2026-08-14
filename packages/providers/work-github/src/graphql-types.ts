/** Minimal shapes for the GitHub GraphQL (Projects v2) API responses this package consumes. */

import type { GraphQLErrorEntry } from './http-errors.js'

export interface GraphQLResponse<T> {
  readonly data?: T
  readonly errors?: readonly GraphQLErrorEntry[]
}

export interface ProjectV2FieldOption {
  readonly id: string
  readonly name: string
}

export interface ProjectV2SingleSelectFieldPayload {
  readonly id: string
  readonly name: string
  readonly options: readonly ProjectV2FieldOption[]
}

export interface ProjectV2ItemFieldValueNode {
  readonly name?: string
  readonly field?: { readonly name?: string }
}

export interface ProjectV2IssueContent {
  readonly __typename: 'Issue'
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: 'OPEN' | 'CLOSED'
  readonly url: string
  readonly labels?: { readonly nodes: readonly { readonly name: string }[] }
  readonly assignees?: { readonly nodes: readonly { readonly login: string }[] }
  readonly repository?: {
    readonly nameWithOwner: string
    readonly defaultBranchRef?: { readonly name: string } | null
  }
}

export interface ProjectV2DraftIssueContent {
  readonly __typename: 'DraftIssue'
  readonly title: string
  readonly body: string | null
}

export type ProjectV2ItemContent = ProjectV2IssueContent | ProjectV2DraftIssueContent | null

export interface ProjectV2Item {
  readonly id: string
  readonly fieldValues: { readonly nodes: readonly ProjectV2ItemFieldValueNode[] }
  readonly content: ProjectV2ItemContent
}

export interface ProjectV2ItemsPage {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }
  readonly nodes: readonly ProjectV2Item[]
}

export interface ProjectV2Payload {
  readonly id: string
  readonly items?: ProjectV2ItemsPage
  readonly field?: ProjectV2SingleSelectFieldPayload | null
}

export type ProjectOwnerPayload = { readonly projectV2: ProjectV2Payload | null } | null

export interface ProjectQueryData {
  readonly organization?: ProjectOwnerPayload
  readonly user?: ProjectOwnerPayload
}

export interface IssueCommentsData {
  readonly node: {
    readonly comments: { readonly nodes: readonly { readonly body: string }[] }
  } | null
}
