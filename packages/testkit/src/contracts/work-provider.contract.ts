/**
 * Behavioral contract every WorkProvider implementation must satisfy:
 * discovery filtering, claim idempotency, transition mutation, and comment
 * recording. Run against fakes and, later, real adapters (GitHub, Jira,
 * Linear) seeded through their own fixtures.
 */

import type { WorkClaim, WorkItem, WorkProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'

/** Populates `provider` with fixtures and returns the items it seeded. */
export type WorkProviderSeeder = (
  provider: WorkProvider,
) => Promise<readonly WorkItem[]> | readonly WorkItem[]

export function describeWorkProviderContract(
  name: string,
  factory: () => WorkProvider | Promise<WorkProvider>,
  seed: WorkProviderSeeder,
): void {
  describe(`WorkProvider contract: ${name}`, () => {
    it('exposes static provider info identifying it as a work provider', async () => {
      const provider = await factory()
      expect(provider.info.id).toBeTruthy()
      expect(provider.info.kind).toBe('work')
    })

    it('discover() filters results by state', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const target = items[0]
      if (!target) throw new Error('seed() must return at least one item')

      const results = await provider.discover({ states: [target.state] })
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((i) => i.state === target.state)).toBe(true)
      expect(results.some((i) => i.id === target.id)).toBe(true)
    })

    it('discover() filters results by included and excluded labels', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const labeled = items.find((i) => i.labels.length > 0)
      if (!labeled) return // fixture set has no labeled items to exercise this on

      const label = labeled.labels[0]
      if (!label) return

      const included = await provider.discover({ labelsInclude: [label] })
      expect(included.every((i) => i.labels.includes(label))).toBe(true)
      expect(included.some((i) => i.id === labeled.id)).toBe(true)

      const excluded = await provider.discover({ labelsExclude: [label] })
      expect(excluded.every((i) => !i.labels.includes(label))).toBe(true)
    })

    it('discover() honors the limit filter', async () => {
      const provider = await factory()
      const items = await seed(provider)
      if (items.length < 2) return // need at least two items to prove truncation

      const results = await provider.discover({ limit: 1 })
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('claim() is idempotent for the same claimant and rejects a competing claimant', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const item = items.find((i) => i.state !== 'done')
      if (!item) throw new Error('seed() must return at least one claimable item')

      const claimA: WorkClaim = { claimant: 'contract-agent-a', runId: 'run-a' }
      const first = await provider.claim(item, claimA)
      expect(first.outcome).toBe('claimed')

      const second = await provider.claim(item, claimA)
      expect(second.outcome).toBe('claimed')

      const claimB: WorkClaim = { claimant: 'contract-agent-b', runId: 'run-b' }
      const third = await provider.claim(item, claimB)
      expect(third.outcome).toBe('already-claimed')
    })

    it('release() allows a subsequent claim by another claimant', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const item = items.find((i) => i.state !== 'done')
      if (!item) throw new Error('seed() must return at least one claimable item')

      const claimA: WorkClaim = { claimant: 'contract-agent-a', runId: 'run-a' }
      await provider.claim(item, claimA)
      await provider.release(item, claimA)

      const claimB: WorkClaim = { claimant: 'contract-agent-b', runId: 'run-b' }
      const result = await provider.claim(item, claimB)
      expect(result.outcome).toBe('claimed')
    })

    it('transition() updates the item state as observed via get()', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const item = items[0]
      if (!item) throw new Error('seed() must return at least one item')

      const states = await provider.listStates(item.repository?.locator)
      const target = states.find((s) => s.id !== item.state) ?? states[0]
      if (!target) throw new Error('listStates() must return at least one state')

      await provider.transition(item, { targetState: target.id })
      const refetched = await provider.get(item.externalId, item.repository?.locator)
      expect(refetched.state).toBe(target.id)
    })

    it('comment() succeeds without throwing', async () => {
      const provider = await factory()
      const items = await seed(provider)
      const item = items[0]
      if (!item) throw new Error('seed() must return at least one item')

      await provider.comment(item, { body: 'contract test comment' })
    })

    it('listStates() returns at least one state', async () => {
      const provider = await factory()
      const states = await provider.listStates()
      expect(states.length).toBeGreaterThan(0)
    })
  })
}
