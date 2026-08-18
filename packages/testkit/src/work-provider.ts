/**
 * FakeWorkProvider: an in-memory WorkProvider seeded with WorkItems. Honors
 * WorkQuery filtering and records every mutating call so tests can assert on
 * exactly what the orchestrator asked of the work system.
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

export type WorkProviderCall =
  | { readonly op: 'discover'; readonly query: WorkQuery; readonly resultCount: number }
  | { readonly op: 'get'; readonly externalId: string; readonly container?: string }
  | {
      readonly op: 'claim'
      readonly item: WorkItem
      readonly claim: WorkClaim
      readonly result: ClaimResult
    }
  | { readonly op: 'release'; readonly item: WorkItem; readonly claim: WorkClaim }
  | { readonly op: 'comment'; readonly item: WorkItem; readonly comment: WorkComment }
  | { readonly op: 'transition'; readonly item: WorkItem; readonly transition: WorkTransition }
  | { readonly op: 'getDescription'; readonly item: WorkItem }
  | { readonly op: 'updateDescription'; readonly item: WorkItem; readonly description: string }

export interface FakeWorkProviderOptions {
  readonly info?: Partial<ProviderInfo>
  readonly states?: readonly WorkStateInfo[]
  /** Item states that cannot be claimed (e.g. already closed). Defaults to ['done']. */
  readonly nonClaimableStates?: readonly string[]
}

const DEFAULT_STATES: readonly WorkStateInfo[] = [
  { id: 'todo', name: 'To Do', category: 'todo' },
  { id: 'in-progress', name: 'In Progress', category: 'in-progress' },
  { id: 'done', name: 'Done', category: 'done' },
]

export class FakeWorkProvider implements WorkProvider {
  readonly info: ProviderInfo
  /** Every discover/get/claim/release/comment/transition call, for assertions. */
  readonly calls: WorkProviderCall[] = []

  private readonly items = new Map<string, WorkItem>()
  private readonly claims = new Map<string, WorkClaim>()
  private readonly states: readonly WorkStateInfo[]
  private readonly nonClaimableStates: ReadonlySet<string>

  constructor(seed: readonly WorkItem[] = [], options: FakeWorkProviderOptions = {}) {
    this.info = {
      id: 'fake-work',
      displayName: 'Fake Work Provider',
      kind: 'work',
      consumption: 'local',
      authentication: ['none'],
      ...options.info,
    }
    this.states = options.states ?? DEFAULT_STATES
    this.nonClaimableStates = new Set(options.nonClaimableStates ?? ['done'])
    for (const item of seed) this.items.set(item.id, item)
  }

  /** Adds or replaces an item in the fake store. */
  seed(item: WorkItem): void {
    this.items.set(item.id, item)
  }

  async detect(): Promise<ProviderAvailability> {
    return { installed: true, authenticated: true, available: true }
  }

  async discover(query: WorkQuery): Promise<readonly WorkItem[]> {
    let results = [...this.items.values()]
    if (query.container) results = results.filter((i) => i.repository?.locator === query.container)
    if (query.states) results = results.filter((i) => query.states?.includes(i.state))
    if (query.labelsInclude) {
      results = results.filter((i) =>
        query.labelsInclude?.every((label) => i.labels.includes(label)),
      )
    }
    if (query.labelsExclude) {
      results = results.filter(
        (i) => !query.labelsExclude?.some((label) => i.labels.includes(label)),
      )
    }
    if (query.assignee) {
      results = results.filter((i) => i.assignees.some((a) => a.id === query.assignee))
    }
    if (query.limit !== undefined) results = results.slice(0, query.limit)
    this.calls.push({ op: 'discover', query, resultCount: results.length })
    return results
  }

  async get(externalId: string, container?: string): Promise<WorkItem> {
    this.calls.push({ op: 'get', externalId, ...(container !== undefined ? { container } : {}) })
    const found = [...this.items.values()].find(
      (i) =>
        i.externalId === externalId &&
        (container === undefined || i.repository?.locator === container),
    )
    if (!found) {
      throw new OrchestratorError(`work item not found: ${externalId}`, 'invalid-input')
    }
    return found
  }

  async claim(item: WorkItem, claim: WorkClaim): Promise<ClaimResult> {
    let result: ClaimResult
    if (this.nonClaimableStates.has(item.state)) {
      result = { outcome: 'not-claimable', detail: `item is in state "${item.state}"` }
    } else {
      const existing = this.claims.get(item.id)
      if (existing && existing.claimant !== claim.claimant) {
        result = { outcome: 'already-claimed', detail: `claimed by "${existing.claimant}"` }
      } else {
        this.claims.set(item.id, claim)
        result = { outcome: 'claimed' }
      }
    }
    this.calls.push({ op: 'claim', item, claim, result })
    return result
  }

  async release(item: WorkItem, claim: WorkClaim): Promise<void> {
    const existing = this.claims.get(item.id)
    if (existing && existing.claimant === claim.claimant) this.claims.delete(item.id)
    this.calls.push({ op: 'release', item, claim })
  }

  async comment(item: WorkItem, comment: WorkComment): Promise<void> {
    this.calls.push({ op: 'comment', item, comment })
  }

  async transition(item: WorkItem, transition: WorkTransition): Promise<void> {
    const stored = this.items.get(item.id)
    if (stored) this.items.set(item.id, { ...stored, state: transition.targetState })
    this.calls.push({ op: 'transition', item, transition })
  }

  async listStates(_container?: string): Promise<readonly WorkStateInfo[]> {
    return this.states
  }

  async getDescription(item: WorkItem): Promise<string> {
    this.calls.push({ op: 'getDescription', item })
    const stored = this.items.get(item.id)
    if (!stored) {
      throw new OrchestratorError(`work item not found: ${item.id}`, 'invalid-input')
    }
    return stored.description ?? ''
  }

  async updateDescription(item: WorkItem, description: string): Promise<void> {
    const stored = this.items.get(item.id)
    if (!stored) {
      throw new OrchestratorError(`work item not found: ${item.id}`, 'invalid-input')
    }
    this.items.set(item.id, { ...stored, description })
    this.calls.push({ op: 'updateDescription', item, description })
  }
}
