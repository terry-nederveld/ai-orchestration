/**
 * LinearWorkProvider: WorkProvider backed by raw fetch against Linear's
 * single GraphQL endpoint. No @linear/sdk dependency — deliberate choice to
 * keep this package zero-dep (matching the model-anthropic pattern) and to
 * keep error mapping and request shaping fully under our control.
 *
 * Claim semantics: Linear has no built-in "claim" concept, so claiming is
 * modeled as a label (default `overture-claimed`) plus a marker comment
 * (`Claimed by <claimant> (run <runId>)`) recording who holds it. The label
 * alone can't distinguish claimants, so claim() re-reads the issue's latest
 * comment to decide between an idempotent re-claim by the same claimant and
 * a competing claim by someone else. This is a best-effort visibility
 * marker per the WorkProvider contract — authoritative idempotent claiming
 * happens in the kernel's ClaimStore.
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
import {
  isAbortError,
  mapGraphQLErrors,
  mapHttpErrorResponse,
  mapNetworkError,
} from './http-errors.js'
import type {
  GraphQLResponse,
  LinearIssue,
  LinearIssueClaimState,
  LinearLabel,
  LinearTeam,
  LinearUser,
} from './linear-types.js'
import { mapIssueToWorkItem, stateToStateInfo } from './mapping.js'
import {
  buildIssueFilter,
  COMMENT_CREATE_MUTATION,
  ISSUE_CLAIM_STATE_QUERY,
  ISSUE_DESCRIPTION_QUERY,
  ISSUE_GET_QUERY,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUES_QUERY,
  TEAM_QUERY,
  VIEWER_QUERY,
} from './queries.js'

const DEFAULT_BASE_URL = 'https://api.linear.app/graphql'
const DEFAULT_CLAIM_LABEL_NAME = 'overture-claimed'
const CLAIM_MARKER_PATTERN = /^Claimed by (.+) \(run (.+)\)$/

export interface LinearWorkProviderOptions {
  /** Async resolver so the API key stays in the secret store, not memory longer than needed. */
  readonly apiKey: () => Promise<string | undefined>
  /** Default team key used when a WorkQuery/container doesn't specify one. */
  readonly teamKey?: string
  /** Personal API keys are sent raw; OAuth tokens need the `Bearer` prefix. Defaults to 'api-key'. */
  readonly authKind?: 'api-key' | 'oauth'
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Label used to mark an issue as claimed. Defaults to 'overture-claimed'. */
  readonly claimLabelName?: string
  readonly baseUrl?: string
}

export class LinearWorkProvider implements WorkProvider {
  readonly info: ProviderInfo = {
    id: 'linear',
    displayName: 'Linear',
    kind: 'work',
    consumption: 'free',
    authentication: ['api-key', 'oauth'],
  }

  private readonly apiKeyResolver: () => Promise<string | undefined>
  private readonly defaultTeamKey: string | undefined
  private readonly authKind: 'api-key' | 'oauth'
  private readonly fetchImpl: typeof fetch
  private readonly claimLabelName: string
  private readonly baseUrl: string

  constructor(options: LinearWorkProviderOptions) {
    this.apiKeyResolver = options.apiKey
    this.defaultTeamKey = options.teamKey
    this.authKind = options.authKind ?? 'api-key'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.claimLabelName = options.claimLabelName ?? DEFAULT_CLAIM_LABEL_NAME
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  async detect(): Promise<ProviderAvailability> {
    const key = await this.apiKeyResolver()
    if (!key) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: this.authKind,
        detail: 'no Linear API key configured',
      }
    }
    try {
      await this.request<{ viewer: LinearUser }>(VIEWER_QUERY)
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: this.authKind,
      }
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: this.authKind,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async discover(query: WorkQuery): Promise<readonly WorkItem[]> {
    const teamKey = query.container ?? this.defaultTeamKey
    const filter = buildIssueFilter(query, teamKey)
    const data = await this.request<{ issues: { nodes: readonly LinearIssue[] } }>(ISSUES_QUERY, {
      filter,
      first: query.limit ?? 50,
    })
    return data.issues.nodes.map(mapIssueToWorkItem)
  }

  async get(externalId: string, _container?: string): Promise<WorkItem> {
    const data = await this.request<{ issue: LinearIssue | null }>(ISSUE_GET_QUERY, {
      id: externalId,
    })
    if (!data.issue) {
      throw new OrchestratorError(`Linear issue not found: ${externalId}`, 'invalid-input')
    }
    return mapIssueToWorkItem(data.issue)
  }

  async claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult> {
    const teamKey = this.resolveTeamKey(item)
    const linearId = this.resolveLinearId(item)
    const team = await this.fetchTeam(teamKey)
    const claimLabel = await this.findOrCreateClaimLabel(team)
    const snapshot = await this.fetchClaimState(linearId, item.externalId)

    const currentLabelIds = snapshot.labels.nodes.map((label) => label.id)
    if (!currentLabelIds.includes(claimLabel.id)) {
      await this.request(ISSUE_UPDATE_MUTATION, {
        id: linearId,
        input: { labelIds: [...currentLabelIds, claimLabel.id] },
      })
      await this.request(COMMENT_CREATE_MUTATION, {
        input: { issueId: linearId, body: `Claimed by ${claim.claimant} (run ${claim.runId})` },
      })
      return { outcome: 'claimed' }
    }

    const lastCommentBody = snapshot.comments.nodes[0]?.body
    const marker = lastCommentBody ? CLAIM_MARKER_PATTERN.exec(lastCommentBody) : null
    if (marker && marker[1] === claim.claimant) {
      return { outcome: 'claimed' }
    }
    return {
      outcome: 'already-claimed',
      detail: marker ? `claimed by "${marker[1]}"` : 'claim label already present',
    }
  }

  async release(item: WorkItem, _claim: WorkClaim): Promise<void> {
    const teamKey = this.resolveTeamKey(item)
    const linearId = this.resolveLinearId(item)
    const team = await this.fetchTeam(teamKey)
    const claimLabel = team.labels.nodes.find((label) => label.name === this.claimLabelName)
    if (!claimLabel) return

    const snapshot = await this.fetchClaimState(linearId, item.externalId)
    const currentLabelIds = snapshot.labels.nodes.map((label) => label.id)
    if (!currentLabelIds.includes(claimLabel.id)) return

    await this.request(ISSUE_UPDATE_MUTATION, {
      id: linearId,
      input: { labelIds: currentLabelIds.filter((id) => id !== claimLabel.id) },
    })
  }

  async comment(item: WorkItem, comment: WorkComment): Promise<void> {
    const linearId = this.resolveLinearId(item)
    await this.request(COMMENT_CREATE_MUTATION, {
      input: { issueId: linearId, body: comment.body },
    })
  }

  async transition(item: WorkItem, transition: WorkTransition): Promise<void> {
    const teamKey = this.resolveTeamKey(item)
    const linearId = this.resolveLinearId(item)
    const team = await this.fetchTeam(teamKey)
    const target = team.states.nodes.find((state) => state.name === transition.targetState)
    if (!target) {
      const available = team.states.nodes.map((state) => state.name).join(', ')
      throw new OrchestratorError(
        `Unknown state "${transition.targetState}" for team ${teamKey}. Available states: ${available}`,
        'invalid-input',
      )
    }

    await this.request(ISSUE_UPDATE_MUTATION, { id: linearId, input: { stateId: target.id } })
    if (transition.comment) {
      await this.request(COMMENT_CREATE_MUTATION, {
        input: { issueId: linearId, body: transition.comment },
      })
    }
  }

  async getDescription(item: WorkItem): Promise<string> {
    const data = await this.request<{ issue: { description: string | null } | null }>(
      ISSUE_DESCRIPTION_QUERY,
      { id: item.externalId },
    )
    if (!data.issue) {
      throw new OrchestratorError(`Linear issue not found: ${item.externalId}`, 'invalid-input')
    }
    return data.issue.description ?? ''
  }

  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const linearId = this.resolveLinearId(item)
    await this.request(ISSUE_UPDATE_MUTATION, { id: linearId, input: { description } })
  }

  async listStates(container?: string): Promise<readonly WorkStateInfo[]> {
    const teamKey = container ?? this.defaultTeamKey
    if (!teamKey) {
      throw new OrchestratorError(
        'listStates() requires a team key: pass a container or configure teamKey',
        'invalid-input',
      )
    }
    const team = await this.fetchTeam(teamKey)
    return team.states.nodes.map(stateToStateInfo)
  }

  private resolveTeamKey(item: WorkItem): string {
    const teamKey = (item.metadata.teamKey as string | undefined) ?? this.defaultTeamKey
    if (!teamKey) {
      throw new OrchestratorError(
        `no team key available for work item ${item.externalId}`,
        'invalid-input',
      )
    }
    return teamKey
  }

  private resolveLinearId(item: WorkItem): string {
    const linearId = item.metadata.linearId as string | undefined
    if (!linearId) {
      throw new OrchestratorError(
        `missing Linear internal id for work item ${item.externalId}`,
        'invalid-input',
      )
    }
    return linearId
  }

  private async fetchTeam(teamKey: string): Promise<LinearTeam> {
    const data = await this.request<{ team: LinearTeam | null }>(TEAM_QUERY, { teamKey })
    if (!data.team) {
      throw new OrchestratorError(`Linear team not found: ${teamKey}`, 'invalid-input')
    }
    return data.team
  }

  private async fetchClaimState(
    linearId: string,
    externalId: string,
  ): Promise<LinearIssueClaimState> {
    const data = await this.request<{ issue: LinearIssueClaimState | null }>(
      ISSUE_CLAIM_STATE_QUERY,
      {
        id: linearId,
      },
    )
    if (!data.issue) {
      throw new OrchestratorError(`Linear issue not found: ${externalId}`, 'invalid-input')
    }
    return data.issue
  }

  private async findOrCreateClaimLabel(team: LinearTeam): Promise<LinearLabel> {
    const existing = team.labels.nodes.find((label) => label.name === this.claimLabelName)
    if (existing) return existing
    const data = await this.request<{ issueLabelCreate: { issueLabel: LinearLabel } }>(
      ISSUE_LABEL_CREATE_MUTATION,
      { input: { name: this.claimLabelName, teamId: team.id } },
    )
    return data.issueLabelCreate.issueLabel
  }

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const key = await this.apiKeyResolver()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) headers.Authorization = this.authKind === 'oauth' ? `Bearer ${key}` : key

    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw mapNetworkError(error)
    }

    if (!response.ok) throw await mapHttpErrorResponse(response)
    const body = (await response.json()) as GraphQLResponse<T>
    if (body.errors && body.errors.length > 0) throw mapGraphQLErrors(body.errors)
    if (body.data === undefined) {
      throw new OrchestratorError('Linear API returned no data', 'corrupt-response')
    }
    return body.data
  }
}
