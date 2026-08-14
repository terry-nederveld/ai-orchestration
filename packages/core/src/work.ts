/**
 * Work-provider contract: external work-management systems normalized to a
 * canonical WorkItem. Provider-specific fields live in `metadata`, never in
 * orchestration logic.
 */

import type { ProviderAvailability, ProviderInfo } from './capabilities.js'
import type { WorkItemId } from './ids.js'

export interface Identity {
  readonly id: string
  readonly displayName?: string
  readonly email?: string
}

export type WorkRelationshipKind =
  | 'blocks'
  | 'blocked-by'
  | 'relates-to'
  | 'parent-of'
  | 'child-of'
  | 'duplicates'

export interface WorkRelationship {
  readonly kind: WorkRelationshipKind
  readonly targetExternalId: string
}

export interface RepositoryReference {
  /** Clone URL or provider-native locator (e.g. `owner/repo`). */
  readonly locator: string
  readonly defaultBranch?: string
  readonly scmProviderId?: string
}

export interface WorkItem {
  /** Canonical internal id: `${provider}:${externalId}`. */
  readonly id: WorkItemId
  readonly provider: string
  readonly externalId: string
  readonly title: string
  readonly description?: string
  readonly state: string
  readonly type?: string
  readonly priority?: string
  readonly labels: readonly string[]
  readonly assignees: readonly Identity[]
  readonly relationships: readonly WorkRelationship[]
  readonly repository?: RepositoryReference
  readonly metadata: Readonly<Record<string, unknown>>
  readonly url?: string
  readonly updatedAt?: Date
}

/** Provider-neutral discovery filter; adapters translate to native queries. */
export interface WorkQuery {
  /** Provider-scoped container: repo, Jira project key, Linear team, etc. */
  readonly container?: string
  readonly states?: readonly string[]
  readonly labelsInclude?: readonly string[]
  readonly labelsExclude?: readonly string[]
  readonly assignee?: string
  readonly limit?: number
  /** Native query escape hatch (JQL, GraphQL filter, search syntax). */
  readonly nativeQuery?: string
}

export interface WorkClaim {
  /** Identifies this orchestrator instance for visibility and audits. */
  readonly claimant: string
  readonly runId: string
}

export type ClaimOutcome = 'claimed' | 'already-claimed' | 'not-claimable'

export interface ClaimResult {
  readonly outcome: ClaimOutcome
  readonly detail?: string
}

export interface WorkComment {
  readonly body: string
}

export interface WorkTransition {
  readonly targetState: string
  readonly comment?: string
}

export interface WorkStateInfo {
  readonly id: string
  readonly name: string
  readonly category?: 'todo' | 'in-progress' | 'done' | 'other'
}

export interface WorkProvider {
  readonly info: ProviderInfo
  detect(): Promise<ProviderAvailability>
  discover(query: WorkQuery): Promise<readonly WorkItem[]>
  get(externalId: string, container?: string): Promise<WorkItem>
  /**
   * Mark the item as being worked in the external system (assignee, label,
   * or status per adapter). Best-effort visibility marker; authoritative
   * idempotent claiming happens in the kernel's ClaimStore.
   */
  claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult>
  release(item: WorkItem, claim: WorkClaim): Promise<void>
  comment(item: WorkItem, comment: WorkComment): Promise<void>
  transition(item: WorkItem, transition: WorkTransition): Promise<void>
  listStates(container?: string): Promise<readonly WorkStateInfo[]>
}
