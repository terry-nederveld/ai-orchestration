/**
 * JiraCloudWorkProvider: WorkProvider backed by the Jira Cloud REST API v3.
 * The old `/rest/api/3/search` endpoint was removed in May 2025; discovery
 * uses `/rest/api/3/search/jql` with nextPageToken-based pagination.
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
import { adfToText, textToAdf } from './adf.js'
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

export type JiraCloudCredentials =
  | { readonly email: string; readonly apiToken: string }
  | { readonly bearer: string }

export interface JiraCloudWorkProviderOptions {
  /** Site subdomain (`mycompany`) or a full `https://mycompany.atlassian.net` URL. */
  readonly site: string
  readonly auth: () => Promise<JiraCloudCredentials | undefined>
  readonly projectKey?: string
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Label used to mark an issue as claimed. Defaults to `overture-claimed`. */
  readonly claimLabel?: string
}

const DEFAULT_LIMIT = 50
const DEFAULT_CLAIM_LABEL = 'overture-claimed'

function resolveSiteHost(site: string): string {
  if (site.startsWith('http://') || site.startsWith('https://')) return new URL(site).host
  return `${site}.atlassian.net`
}

export class JiraCloudWorkProvider implements WorkProvider {
  readonly info: ProviderInfo = {
    id: 'jira-cloud',
    displayName: 'Jira Cloud',
    kind: 'work',
    consumption: 'free',
    authentication: ['api-key', 'oauth'],
  }

  private readonly siteHost: string
  private readonly baseUrl: string
  private readonly authResolver: () => Promise<JiraCloudCredentials | undefined>
  private readonly projectKey: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly claimLabel: string

  constructor(options: JiraCloudWorkProviderOptions) {
    this.siteHost = resolveSiteHost(options.site)
    this.baseUrl = `https://${this.siteHost}/rest/api/3`
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
        detail: 'no Jira Cloud credentials configured',
      }
    }
    const authenticationKind = 'bearer' in creds ? 'oauth' : 'api-key'
    try {
      const response = await this.rawFetch('/myself', { method: 'GET' })
      if (!response.ok) throw await mapHttpErrorResponse(response)
      return { installed: true, authenticated: true, available: true, authenticationKind }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async discover(query: WorkQuery): Promise<readonly WorkItem[]> {
    const jql = buildJql(query, this.projectKey)
    const limit = query.limit ?? DEFAULT_LIMIT
    const items: WorkItem[] = []
    let nextPageToken: string | undefined

    for (;;) {
      const remaining = limit - items.length
      if (remaining <= 0) break

      const params = new URLSearchParams({
        jql,
        maxResults: String(Math.min(remaining, 100)),
        fields: SEARCH_FIELDS,
      })
      if (nextPageToken) params.set('nextPageToken', nextPageToken)

      const response = await this.rawFetch(`/search/jql?${params.toString()}`, { method: 'GET' })
      if (!response.ok) throw await mapHttpErrorResponse(response)
      const body = (await response.json()) as JiraSearchResponse

      for (const issue of body.issues) items.push(mapIssueToWorkItem(issue, this.siteHost))

      nextPageToken = body.nextPageToken
      if (body.isLast || !nextPageToken || body.issues.length === 0) break
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
    return mapIssueToWorkItem(issue, this.siteHost)
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
      body: JSON.stringify({ body: textToAdf(comment.body) }),
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
      body.update = { comment: [{ add: { body: textToAdf(transition.comment) } }] }
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
    return adfToText(issue.fields.description)
  }

  /**
   * Fidelity caveat: Jira Cloud stores descriptions as ADF, and this adapter
   * only speaks plain text. Round-tripping getDescription() -> edit ->
   * updateDescription() flattens rich content (tables, mentions, panels,
   * formatting marks) into the plain text adfToText() extracted from it —
   * the replacement body is a single plain-text paragraph.
   */
  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const response = await this.rawFetch(`/issue/${encodeURIComponent(item.externalId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { description: textToAdf(description) } }),
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
    if ('bearer' in creds) return { Authorization: `Bearer ${creds.bearer}` }
    const token = Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')
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
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
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
