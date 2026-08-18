/**
 * GitHubProjectsWorkProvider: WorkProvider backed by the GitHub GraphQL API.
 * Projects v2 has no REST surface, so unlike GitHubIssuesWorkProvider this
 * adapter is GraphQL-only end to end.
 *
 * Claiming is comment-marker based rather than label based (see
 * claim-markers.ts): GraphQL label mutations need a label *id*, resolving or
 * creating one needs either an extra query per repo or REST access we've
 * deliberately avoided here, so claim/release ride on the same issue-comment
 * marker mechanism the Issues provider uses to track *who* holds a claim.
 * Draft items have no underlying issue, so they're not claimable or
 * commentable at all.
 */

import {
  type ClaimResult,
  OrchestratorError,
  type ProviderAvailability,
  type ProviderInfo,
  type WorkClaim,
  type WorkComment,
  type WorkItem,
  type WorkItemDraft,
  type WorkProvider,
  type WorkQuery,
  type WorkStateInfo,
  type WorkTransition,
} from '@overture/core'
import { findLatestClaimMarker, formatClaimMarker } from './claim-markers.js'
import type {
  GraphQLResponse,
  IssueCommentsData,
  ProjectQueryData,
  ProjectV2Item,
} from './graphql-types.js'
import type { GraphQLErrorEntry } from './http-errors.js'
import { mapGraphQLErrors, mapHttpErrorResponse, mapNetworkError } from './http-errors.js'
import { contentNodeIdOf, projectItemToWorkItem } from './projects-mapping.js'

const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql'
const DEFAULT_STATUS_FIELD_NAME = 'Status'
const PAGE_SIZE = 50

export interface GitHubProjectsWorkProviderOptions {
  readonly token: () => Promise<string | undefined>
  readonly owner: string
  readonly ownerType: 'organization' | 'user'
  readonly projectNumber: number
  /** GraphQL endpoint override; defaults to https://api.github.com/graphql. */
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  /** Name of the single-select field driving WorkItem.state. Defaults to "Status". */
  readonly statusFieldName?: string
}

const ITEMS_FRAGMENT = `
  id
  fieldValues(first: 20) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { name } }
      }
    }
  }
  content {
    __typename
    ... on Issue {
      id
      number
      title
      body
      state
      url
      labels(first: 20) { nodes { name } }
      assignees(first: 20) { nodes { login } }
      repository { nameWithOwner defaultBranchRef { name } }
    }
    ... on DraftIssue {
      title
      body
    }
  }
`

function itemsQuery(ownerType: 'organization' | 'user'): string {
  return `
    query($login: String!, $number: Int!, $pageSize: Int!, $cursor: String) {
      ${ownerType}(login: $login) {
        projectV2(number: $number) {
          id
          items(first: $pageSize, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ITEMS_FRAGMENT} }
          }
        }
      }
    }
  `
}

function nodeQuery(): string {
  return `
    query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2Item { ${ITEMS_FRAGMENT} }
      }
    }
  `
}

function fieldQuery(ownerType: 'organization' | 'user'): string {
  return `
    query($login: String!, $number: Int!, $fieldName: String!) {
      ${ownerType}(login: $login) {
        projectV2(number: $number) {
          id
          field(name: $fieldName) {
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
      }
    }
  `
}

const ISSUE_COMMENTS_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on Issue {
        comments(last: 50) { nodes { body } }
      }
    }
  }
`

const ADD_COMMENT_MUTATION = `
  mutation($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
  }
`

const UPDATE_ISSUE_BODY_MUTATION = `
  mutation($id: ID!, $body: String!) {
    updateIssue(input: { id: $id, body: $body }) { clientMutationId }
  }
`

const ADD_DRAFT_ISSUE_MUTATION = `
  mutation($projectId: ID!, $title: String!, $body: String) {
    addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
      projectItem { ${ITEMS_FRAGMENT} }
    }
  }
`

const UPDATE_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) { clientMutationId }
  }
`

interface StatusFieldInfo {
  readonly projectId: string
  readonly fieldId: string
  readonly options: ReadonlyMap<string, string>
}

export class GitHubProjectsWorkProvider implements WorkProvider {
  readonly info: ProviderInfo = {
    id: 'github-projects',
    displayName: 'GitHub Projects',
    kind: 'work',
    consumption: 'free',
    authentication: ['api-key', 'oauth', 'cli-session'],
  }

  private readonly tokenResolver: () => Promise<string | undefined>
  private readonly owner: string
  private readonly ownerType: 'organization' | 'user'
  private readonly projectNumber: number
  private readonly graphqlUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly statusFieldName: string
  private statusFieldCache: StatusFieldInfo | undefined

  constructor(options: GitHubProjectsWorkProviderOptions) {
    this.tokenResolver = options.token
    this.owner = options.owner
    this.ownerType = options.ownerType
    this.projectNumber = options.projectNumber
    this.graphqlUrl = options.baseUrl ?? DEFAULT_GRAPHQL_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.statusFieldName = options.statusFieldName ?? DEFAULT_STATUS_FIELD_NAME
  }

  async detect(): Promise<ProviderAvailability> {
    const token = await this.tokenResolver()
    if (!token) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'api-key',
        detail: 'no GitHub token configured',
      }
    }
    try {
      await this.resolveStatusField()
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: 'api-key',
      }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'api-key',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async discover(query: WorkQuery): Promise<readonly WorkItem[]> {
    const maxItems = query.limit ?? 100
    const items: WorkItem[] = []
    let cursor: string | undefined

    while (items.length < maxItems) {
      const data = await this.graphql<ProjectQueryData>(itemsQuery(this.ownerType), {
        login: this.owner,
        number: this.projectNumber,
        pageSize: PAGE_SIZE,
        cursor: cursor ?? null,
      })
      const page = data[this.ownerType]?.projectV2?.items
      if (!page) break

      for (const node of page.nodes) {
        const mapped = projectItemToWorkItem(node, this.statusFieldName)
        if (query.states && !query.states.includes(mapped.state)) continue
        if (query.container && mapped.repository?.locator !== query.container) continue
        items.push(mapped)
        if (items.length >= maxItems) break
      }

      if (!page.pageInfo.hasNextPage || items.length >= maxItems) break
      cursor = page.pageInfo.endCursor ?? undefined
    }

    return items
  }

  async get(externalId: string): Promise<WorkItem> {
    const data = await this.graphql<{ node: ProjectV2Item | null }>(nodeQuery(), { id: externalId })
    if (!data.node) {
      throw new OrchestratorError(`project item not found: ${externalId}`, 'invalid-input')
    }
    return projectItemToWorkItem(data.node, this.statusFieldName)
  }

  async claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult> {
    const contentId = contentNodeIdOf(item)
    if (!contentId) {
      return { outcome: 'not-claimable', detail: 'draft items have no underlying issue to claim' }
    }

    const comments = await this.fetchIssueComments(contentId)
    const marker = findLatestClaimMarker(comments)
    if (marker?.kind === 'claim') {
      if (marker.claimant === claim.claimant) return { outcome: 'claimed' }
      return { outcome: 'already-claimed', detail: `claimed by "${marker.claimant}"` }
    }

    await this.addIssueComment(contentId, formatClaimMarker('claim', claim.claimant, claim.runId))
    return { outcome: 'claimed' }
  }

  async release(item: WorkItem, claim: WorkClaim): Promise<void> {
    const contentId = contentNodeIdOf(item)
    if (!contentId) return
    await this.addIssueComment(contentId, formatClaimMarker('release', claim.claimant, claim.runId))
  }

  async comment(item: WorkItem, comment: WorkComment): Promise<void> {
    const contentId = contentNodeIdOf(item)
    if (!contentId) {
      throw new OrchestratorError(
        'cannot comment on a draft item: drafts have no underlying issue',
        'invalid-input',
      )
    }
    await this.addIssueComment(contentId, comment.body)
  }

  async transition(item: WorkItem, transition: WorkTransition): Promise<void> {
    const { projectId, fieldId, options } = await this.resolveStatusField()
    const optionId = options.get(transition.targetState)
    if (!optionId) {
      throw new OrchestratorError(
        `unknown status option "${transition.targetState}" for field "${this.statusFieldName}"`,
        'invalid-input',
      )
    }

    await this.graphql(UPDATE_FIELD_MUTATION, {
      projectId,
      itemId: item.externalId,
      fieldId,
      optionId,
    })

    if (transition.comment) {
      const contentId = contentNodeIdOf(item)
      if (contentId) await this.addIssueComment(contentId, transition.comment)
    }
  }

  async getDescription(item: WorkItem): Promise<string> {
    const data = await this.graphql<{ node: ProjectV2Item | null }>(nodeQuery(), {
      id: item.externalId,
    })
    if (!data.node) {
      throw new OrchestratorError(`project item not found: ${item.externalId}`, 'invalid-input')
    }
    return data.node.content?.body ?? ''
  }

  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const contentId = contentNodeIdOf(item)
    if (!contentId) {
      throw new OrchestratorError(
        'cannot update the body of a draft item: drafts have no underlying issue',
        'invalid-input',
      )
    }
    await this.graphql(UPDATE_ISSUE_BODY_MUTATION, { id: contentId, body: description })
  }

  /**
   * Limitation: creating a real issue requires a repository, which a project
   * doesn't have, so createItem() adds a *draft* item (type 'draft'). Drafts
   * carry no labels or type, so those draft fields are ignored, and drafts
   * can't be related to other items — linkItems is intentionally absent on
   * this provider, and a relateTo request fails rather than silently
   * dropping the relationship.
   */
  async createItem(draft: WorkItemDraft): Promise<WorkItem> {
    if (draft.relateTo) {
      throw new OrchestratorError(
        'cannot relate a draft project item: drafts have no underlying issue to link',
        'invalid-input',
      )
    }
    const { projectId } = await this.resolveStatusField()
    const data = await this.graphql<{
      addProjectV2DraftIssue: { projectItem: ProjectV2Item | null } | null
    }>(ADD_DRAFT_ISSUE_MUTATION, {
      projectId,
      title: draft.title,
      body: draft.description ?? null,
    })
    const projectItem = data.addProjectV2DraftIssue?.projectItem
    if (!projectItem) {
      throw new OrchestratorError(
        'addProjectV2DraftIssue returned no project item',
        'corrupt-response',
      )
    }
    return projectItemToWorkItem(projectItem, this.statusFieldName)
  }

  async listStates(): Promise<readonly WorkStateInfo[]> {
    const { options } = await this.resolveStatusField()
    return [...options.keys()].map((name) => ({ id: name, name }))
  }

  private async resolveStatusField(): Promise<StatusFieldInfo> {
    if (this.statusFieldCache) return this.statusFieldCache
    const data = await this.graphql<ProjectQueryData>(fieldQuery(this.ownerType), {
      login: this.owner,
      number: this.projectNumber,
      fieldName: this.statusFieldName,
    })
    const project = data[this.ownerType]?.projectV2
    if (!project?.field) {
      throw new OrchestratorError(
        `status field "${this.statusFieldName}" not found on project ${this.owner}/#${this.projectNumber}`,
        'invalid-input',
      )
    }
    const options = new Map(project.field.options.map((o) => [o.name, o.id]))
    this.statusFieldCache = { projectId: project.id, fieldId: project.field.id, options }
    return this.statusFieldCache
  }

  private async fetchIssueComments(contentId: string): Promise<readonly string[]> {
    const data = await this.graphql<IssueCommentsData>(ISSUE_COMMENTS_QUERY, { id: contentId })
    return data.node?.comments.nodes.map((c) => c.body) ?? []
  }

  private async addIssueComment(contentId: string, body: string): Promise<void> {
    await this.graphql(ADD_COMMENT_MUTATION, { subjectId: contentId, body })
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.tokenResolver()
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    }
    if (token) headers.authorization = `Bearer ${token}`

    let response: Response
    try {
      response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      })
    } catch (error) {
      throw mapNetworkError(error)
    }
    if (!response.ok) throw await mapHttpErrorResponse(response)

    const parsed = (await response.json()) as GraphQLResponse<T>
    if (parsed.errors && parsed.errors.length > 0) {
      throw mapGraphQLErrors(parsed.errors as readonly GraphQLErrorEntry[])
    }
    if (!parsed.data) {
      throw new OrchestratorError('GitHub GraphQL response had no data', 'corrupt-response')
    }
    return parsed.data
  }
}
