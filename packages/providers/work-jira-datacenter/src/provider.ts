/**
 * JiraDataCenterWorkProvider: WorkProvider backed by the Jira Data Center
 * (Server) REST API v2. Data Center has no `/search/jql` endpoint; discovery
 * uses the classic `/rest/api/2/search` with startAt/maxResults offset
 * pagination, and rich text is always a plain string, never ADF.
 */

import {
  type ClaimResult,
  OrchestratorError,
  type ProviderAvailability,
  type ProviderInfo,
  type WorkClaim,
  type WorkComment,
  type WorkItem,
  type WorkProvider,
  type WorkQuery,
  type WorkStateInfo,
  type WorkTransition,
} from '@overture/core'
import { isAbortError, mapHttpErrorResponse, mapNetworkError } from './http-errors.js'
import type {
  JiraIssue,
  JiraProjectStatusesEntry,
  JiraSearchResponse,
  JiraStatus,
  JiraTransitionsResponse,
} from './jira-types.js'
import { buildJql } from './jql.js'
import { mapIssueToWorkItem, SEARCH_FIELDS, statusToStateInfo } from './mapping.js'

export type JiraDataCenterCredentials =
  | { readonly pat: string }
  | { readonly username: string; readonly password: string }

export interface JiraDataCenterWorkProviderOptions {
  /** Full base URL, e.g. `https://jira.company.com`. */
  readonly baseUrl: string
  readonly auth: () => Promise<JiraDataCenterCredentials | undefined>
  readonly projectKey?: string
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Label used to mark an issue as claimed. Defaults to `overture-claimed`. */
  readonly claimLabel?: string
}

const DEFAULT_LIMIT = 50
const DEFAULT_CLAIM_LABEL = 'overture-claimed'

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export class JiraDataCenterWorkProvider implements WorkProvider {
  readonly info: ProviderInfo = {
    id: 'jira-datacenter',
    displayName: 'Jira Data Center',
    kind: 'work',
    consumption: 'free',
    authentication: ['api-key'],
  }

  private readonly siteBaseUrl: string
  private readonly apiBaseUrl: string
  private readonly authResolver: () => Promise<JiraDataCenterCredentials | undefined>
  private readonly projectKey: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly claimLabel: string

  constructor(options: JiraDataCenterWorkProviderOptions) {
    this.siteBaseUrl = stripTrailingSlash(options.baseUrl)
    this.apiBaseUrl = `${this.siteBaseUrl}/rest/api/2`
    this.authResolver = options.auth
    this.projectKey = options.projectKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.claimLabel = options.claimLabel ?? DEFAULT_CLAIM_LABEL
  }

  async detect(): Promise<ProviderAvailability> {
    const creds = await this.authResolver()
    if (!creds) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'api-key',
        detail: 'no Jira Data Center credentials configured',
      }
    }
    try {
      const response = await this.rawFetch('/myself', { method: 'GET' })
      if (!response.ok) throw await mapHttpErrorResponse(response)
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
    const jql = buildJql(query, this.projectKey)
    const limit = query.limit ?? DEFAULT_LIMIT
    const items: WorkItem[] = []
    let startAt = 0

    for (;;) {
      const remaining = limit - items.length
      if (remaining <= 0) break

      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(Math.min(remaining, 100)),
        fields: SEARCH_FIELDS,
      })

      const response = await this.rawFetch(`/search?${params.toString()}`, { method: 'GET' })
      if (!response.ok) throw await mapHttpErrorResponse(response)
      const body = (await response.json()) as JiraSearchResponse

      for (const issue of body.issues) items.push(mapIssueToWorkItem(issue, this.siteBaseUrl))

      startAt += body.issues.length
      if (body.issues.length === 0 || startAt >= body.total) break
    }

    return items.slice(0, limit)
  }

  async get(externalId: string, _container?: string): Promise<WorkItem> {
    const params = new URLSearchParams({ fields: SEARCH_FIELDS })
    const response = await this.rawFetch(`/issue/${encodeURIComponent(externalId)}?${params}`, {
      method: 'GET',
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const issue = (await response.json()) as JiraIssue
    return mapIssueToWorkItem(issue, this.siteBaseUrl)
  }

  async claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult> {
    if (item.labels.includes(this.claimLabel)) {
      return {
        outcome: 'already-claimed',
        detail: `issue ${item.externalId} already has label "${this.claimLabel}"`,
      }
    }

    const response = await this.rawFetch(`/issue/${encodeURIComponent(item.externalId)}`, {
      method: 'PUT',
      body: JSON.stringify({ update: { labels: [{ add: this.claimLabel }] } }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)

    await this.comment(item, { body: `Claimed by ${claim.claimant} (run ${claim.runId}).` })
    return { outcome: 'claimed' }
  }

  async release(item: WorkItem, _claim: WorkClaim): Promise<void> {
    const response = await this.rawFetch(`/issue/${encodeURIComponent(item.externalId)}`, {
      method: 'PUT',
      body: JSON.stringify({ update: { labels: [{ remove: this.claimLabel }] } }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  async comment(item: WorkItem, comment: WorkComment): Promise<void> {
    const response = await this.rawFetch(`/issue/${encodeURIComponent(item.externalId)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: comment.body }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  async transition(item: WorkItem, transition: WorkTransition): Promise<void> {
    const listResponse = await this.rawFetch(
      `/issue/${encodeURIComponent(item.externalId)}/transitions`,
      { method: 'GET' },
    )
    if (!listResponse.ok) throw await mapHttpErrorResponse(listResponse)
    const { transitions } = (await listResponse.json()) as JiraTransitionsResponse

    const target = transitions.find(
      (t) =>
        t.to?.name?.toLowerCase() === transition.targetState.toLowerCase() ||
        t.name.toLowerCase() === transition.targetState.toLowerCase(),
    )
    if (!target) {
      const available = transitions.map((t) => t.name).join(', ')
      throw new OrchestratorError(
        `no transition to state "${transition.targetState}" is available for ${item.externalId}; available transitions: ${available}`,
        'invalid-input',
      )
    }

    const body: Record<string, unknown> = { transition: { id: target.id } }
    if (transition.comment) {
      body.update = { comment: [{ add: { body: transition.comment } }] }
    }

    const postResponse = await this.rawFetch(
      `/issue/${encodeURIComponent(item.externalId)}/transitions`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    if (!postResponse.ok) throw await mapHttpErrorResponse(postResponse)
  }

  async getDescription(item: WorkItem): Promise<string> {
    const params = new URLSearchParams({ fields: 'description' })
    const response = await this.rawFetch(
      `/issue/${encodeURIComponent(item.externalId)}?${params}`,
      {
        method: 'GET',
      },
    )
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const issue = (await response.json()) as JiraIssue
    return issue.fields.description ?? ''
  }

  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const response = await this.rawFetch(`/issue/${encodeURIComponent(item.externalId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { description } }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  async listStates(container?: string): Promise<readonly WorkStateInfo[]> {
    const key = container ?? this.projectKey
    if (key) {
      const response = await this.rawFetch(`/project/${encodeURIComponent(key)}/statuses`, {
        method: 'GET',
      })
      if (!response.ok) throw await mapHttpErrorResponse(response)
      const entries = (await response.json()) as readonly JiraProjectStatusesEntry[]
      const byId = new Map<string, WorkStateInfo>()
      for (const entry of entries) {
        for (const status of entry.statuses) byId.set(status.id, statusToStateInfo(status))
      }
      return [...byId.values()]
    }

    const response = await this.rawFetch('/status', { method: 'GET' })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    const statuses = (await response.json()) as readonly JiraStatus[]
    return statuses.map(statusToStateInfo)
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const creds = await this.authResolver()
    if (!creds) return {}
    if ('pat' in creds) return { Authorization: `Bearer ${creds.pat}` }
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
    return { Authorization: `Basic ${token}` }
  }

  private async rawFetch(
    path: string,
    init: { method: 'GET' | 'POST' | 'PUT'; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(await this.authHeaders()),
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'

    try {
      return await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw mapNetworkError(error)
    }
  }
}
