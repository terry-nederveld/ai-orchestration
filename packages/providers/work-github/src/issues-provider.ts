/**
 * GitHubIssuesWorkProvider: WorkProvider backed by raw fetch against the
 * GitHub REST API. No vendor SDK dependency, so error mapping stays fully
 * under our control (mirrors the AnthropicModelProvider pattern).
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
import { findLatestClaimMarker, formatClaimMarker } from './claim-markers.js'
import { mapHttpErrorResponse, mapNetworkError } from './http-errors.js'
import { isPullRequest, issueToWorkItem, labelName, parseNextLink } from './issues-mapping.js'
import type { GitHubComment, GitHubIssue, GitHubUser } from './rest-types.js'

const GITHUB_API_VERSION = '2022-11-28'
const DEFAULT_BASE_URL = 'https://api.github.com'
const DEFAULT_CLAIM_LABEL = 'overture:claimed'

export interface GitHubIssuesWorkProviderOptions {
  /** Async resolver so the token stays in the secret store, not memory longer than needed. */
  readonly token: () => Promise<string | undefined>
  /** `owner/name`. */
  readonly repo: string
  readonly baseUrl?: string
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Label added by claim() / removed by release(). Defaults to "overture:claimed". */
  readonly claimLabel?: string
  readonly defaultBranch?: string
  /**
   * Workflow state name -> label to apply for transition() targets other
   * than "open"/"closed". Native GitHub issues have no state machine beyond
   * open/closed, so richer workflow states are modeled as mutually exclusive
   * labels: transitioning to a configured state removes every other
   * configured state's label from the issue and adds this one. discover()
   * and get() report one of these names as the item's state whenever the
   * corresponding label is present on an open issue.
   */
  readonly stateLabels?: Readonly<Record<string, string>>
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export class GitHubIssuesWorkProvider implements WorkProvider {
  readonly info: ProviderInfo = {
    id: 'github',
    displayName: 'GitHub Issues',
    kind: 'work',
    consumption: 'free',
    authentication: ['api-key', 'oauth', 'cli-session'],
  }

  private readonly tokenResolver: () => Promise<string | undefined>
  private readonly repo: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly claimLabel: string
  private readonly defaultBranch: string | undefined
  private readonly stateLabels: Readonly<Record<string, string>>
  private viewerLoginPromise: Promise<string | undefined> | undefined

  constructor(options: GitHubIssuesWorkProviderOptions) {
    this.tokenResolver = options.token
    this.repo = options.repo
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.claimLabel = options.claimLabel ?? DEFAULT_CLAIM_LABEL
    this.defaultBranch = options.defaultBranch
    this.stateLabels = options.stateLabels ?? {}
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
      const response = await this.rawFetch('/user', { method: 'GET' })
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
    const container = query.container ?? this.repo
    const requestedStates = query.states
    const singleNativeState =
      requestedStates?.length === 1 &&
      (requestedStates[0] === 'open' || requestedStates[0] === 'closed')
        ? requestedStates[0]
        : undefined
    const nativeState = singleNativeState ?? (requestedStates ? 'all' : 'open')
    const maxItems = query.limit ?? 100
    const perPage = Math.min(100, maxItems)

    const params = new URLSearchParams({ state: nativeState, per_page: String(perPage) })
    if (query.labelsInclude?.length) params.set('labels', query.labelsInclude.join(','))
    if (query.assignee) params.set('assignee', query.assignee)

    const items: WorkItem[] = []
    let next: string | undefined = `/repos/${container}/issues?${params.toString()}`

    while (next && items.length < maxItems) {
      const response = await this.rawFetch(next, { method: 'GET' })
      if (!response.ok) throw await mapHttpErrorResponse(response)
      const issues = (await response.json()) as GitHubIssue[]

      for (const issue of issues) {
        if (isPullRequest(issue)) continue
        const mapped = issueToWorkItem(issue, container, this.defaultBranch, this.stateLabels)
        if (requestedStates && !requestedStates.includes(mapped.state)) continue
        if (query.labelsExclude?.some((l) => mapped.labels.includes(l))) continue
        items.push(mapped)
        if (items.length >= maxItems) break
      }

      next = items.length < maxItems ? parseNextLink(response.headers.get('link')) : undefined
    }

    return items
  }

  async get(externalId: string, container?: string): Promise<WorkItem> {
    const repo = container ?? this.repo
    const issue = await this.fetchIssue(repo, externalId)
    return issueToWorkItem(issue, repo, this.defaultBranch, this.stateLabels)
  }

  async claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult> {
    const container = item.repository?.locator ?? this.repo
    const number = item.externalId
    const current = await this.fetchIssue(container, number)
    const hasClaimLabel = current.labels.some((l) => labelName(l) === this.claimLabel)

    if (hasClaimLabel) {
      const comments = await this.fetchComments(container, number)
      const marker = findLatestClaimMarker(comments.map((c) => c.body))
      if (marker?.kind === 'claim' && marker.claimant === claim.claimant) {
        return { outcome: 'claimed' }
      }
      return {
        outcome: 'already-claimed',
        ...(marker?.kind === 'claim' ? { detail: `claimed by "${marker.claimant}"` } : {}),
      }
    }

    await this.addLabels(container, number, [this.claimLabel])
    const viewer = await this.getViewerLogin()
    if (viewer) {
      // Best-effort visibility marker: the claim label + comment marker are
      // authoritative, so a failure to assign shouldn't fail the claim.
      await this.addAssignees(container, number, [viewer]).catch(() => {})
    }
    await this.addComment(
      container,
      number,
      formatClaimMarker('claim', claim.claimant, claim.runId),
    )
    return { outcome: 'claimed' }
  }

  async release(item: WorkItem, claim: WorkClaim): Promise<void> {
    const container = item.repository?.locator ?? this.repo
    const number = item.externalId
    await this.removeLabel(container, number, this.claimLabel)
    await this.addComment(
      container,
      number,
      formatClaimMarker('release', claim.claimant, claim.runId),
    )
  }

  async comment(item: WorkItem, comment: WorkComment): Promise<void> {
    const container = item.repository?.locator ?? this.repo
    await this.addComment(container, item.externalId, comment.body)
  }

  async transition(item: WorkItem, transition: WorkTransition): Promise<void> {
    const container = item.repository?.locator ?? this.repo
    const number = item.externalId
    const target = transition.targetState

    if (target === 'closed') {
      await this.patchIssue(container, number, { state: 'closed', state_reason: 'completed' })
    } else if (target === 'open') {
      await this.patchIssue(container, number, { state: 'open' })
    } else {
      const label = this.stateLabels[target]
      if (!label) {
        throw new OrchestratorError(
          `cannot transition to "${target}": not "open", "closed", or a configured stateLabels key`,
          'invalid-input',
        )
      }
      const current = await this.fetchIssue(container, number)
      const otherStateLabels = new Set(Object.values(this.stateLabels).filter((l) => l !== label))
      for (const name of current.labels.map(labelName)) {
        if (otherStateLabels.has(name)) await this.removeLabel(container, number, name)
      }
      if (!current.labels.some((l) => labelName(l) === label)) {
        await this.addLabels(container, number, [label])
      }
    }

    if (transition.comment) await this.addComment(container, number, transition.comment)
  }

  async getDescription(item: WorkItem): Promise<string> {
    const container = item.repository?.locator ?? this.repo
    const issue = await this.fetchIssue(container, item.externalId)
    return issue.body ?? ''
  }

  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const container = item.repository?.locator ?? this.repo
    await this.patchIssue(container, item.externalId, { body: description })
  }

  async listStates(_container?: string): Promise<readonly WorkStateInfo[]> {
    return [
      { id: 'open', name: 'Open', category: 'todo' },
      { id: 'closed', name: 'Closed', category: 'done' },
      ...Object.keys(this.stateLabels).map((name) => ({
        id: name,
        name,
        category: 'other' as const,
      })),
    ]
  }

  private async getViewerLogin(): Promise<string | undefined> {
    if (!this.viewerLoginPromise) {
      this.viewerLoginPromise = this.rawFetch('/user', { method: 'GET' })
        .then(async (response) => {
          if (!response.ok) return undefined
          const user = (await response.json()) as GitHubUser
          return user.login
        })
        .catch(() => undefined)
    }
    return this.viewerLoginPromise
  }

  private async fetchIssue(container: string, number: string): Promise<GitHubIssue> {
    const response = await this.rawFetch(`/repos/${container}/issues/${number}`, { method: 'GET' })
    if (!response.ok) throw await mapHttpErrorResponse(response)
    return (await response.json()) as GitHubIssue
  }

  private async fetchComments(
    container: string,
    number: string,
  ): Promise<readonly GitHubComment[]> {
    const response = await this.rawFetch(
      `/repos/${container}/issues/${number}/comments?per_page=100`,
      {
        method: 'GET',
      },
    )
    if (!response.ok) throw await mapHttpErrorResponse(response)
    return (await response.json()) as GitHubComment[]
  }

  private async addComment(container: string, number: string, body: string): Promise<void> {
    const response = await this.rawFetch(`/repos/${container}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  private async addLabels(
    container: string,
    number: string,
    labels: readonly string[],
  ): Promise<void> {
    const response = await this.rawFetch(`/repos/${container}/issues/${number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  /** Tolerates 404 (label already absent) since removal is meant to be idempotent. */
  private async removeLabel(container: string, number: string, label: string): Promise<void> {
    const response = await this.rawFetch(
      `/repos/${container}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    )
    if (!response.ok && response.status !== 404) throw await mapHttpErrorResponse(response)
  }

  private async addAssignees(
    container: string,
    number: string,
    assignees: readonly string[],
  ): Promise<void> {
    const response = await this.rawFetch(`/repos/${container}/issues/${number}/assignees`, {
      method: 'POST',
      body: JSON.stringify({ assignees }),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  private async patchIssue(
    container: string,
    number: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.rawFetch(`/repos/${container}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await mapHttpErrorResponse(response)
  }

  private async rawFetch(
    pathOrUrl: string,
    init: { method: HttpMethod; body?: string },
  ): Promise<Response> {
    const token = await this.tokenResolver()
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      })
    } catch (error) {
      throw mapNetworkError(error)
    }
  }
}
