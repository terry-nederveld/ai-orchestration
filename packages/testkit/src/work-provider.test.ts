import type { WorkItem, WorkProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { describeWorkProviderContract } from './contracts/work-provider.contract.js'
import { makeWorkItem } from './fixtures.js'
import { FakeWorkProvider } from './work-provider.js'

function seedFixtures(provider: WorkProvider): readonly WorkItem[] {
  const items = [
    makeWorkItem({
      externalId: 'A-1',
      state: 'todo',
      labels: ['bug'],
      repository: { locator: 'org/repo' },
    }),
    makeWorkItem({
      externalId: 'A-2',
      state: 'in-progress',
      labels: ['feature'],
      repository: { locator: 'org/repo' },
    }),
    makeWorkItem({
      externalId: 'A-3',
      state: 'done',
      labels: ['bug'],
      repository: { locator: 'org/repo' },
    }),
  ]
  for (const item of items) (provider as FakeWorkProvider).seed(item)
  return items
}

describeWorkProviderContract('FakeWorkProvider', () => new FakeWorkProvider(), seedFixtures)

describe('FakeWorkProvider', () => {
  it('discover() applies container, state, and label filters together', async () => {
    const provider = new FakeWorkProvider()
    const items = seedFixtures(provider)
    const results = await provider.discover({
      container: 'org/repo',
      states: ['todo'],
      labelsInclude: ['bug'],
    })
    expect(results.map((i) => i.id)).toEqual([items[0]?.id])
  })

  it('claim() reports not-claimable for items in a configured non-claimable state', async () => {
    const provider = new FakeWorkProvider()
    const items = seedFixtures(provider)
    const done = items[2]
    if (!done) throw new Error('expected a seeded item')
    const result = await provider.claim(done, { claimant: 'agent', runId: 'run-1' })
    expect(result.outcome).toBe('not-claimable')
  })

  it('records a call log for discover, claim, comment, and transition', async () => {
    const provider = new FakeWorkProvider()
    const items = seedFixtures(provider)
    const item = items[0]
    if (!item) throw new Error('expected a seeded item')

    await provider.discover({})
    await provider.claim(item, { claimant: 'agent', runId: 'run-1' })
    await provider.comment(item, { body: 'hi' })
    await provider.transition(item, { targetState: 'in-progress' })

    expect(provider.calls.map((c) => c.op)).toEqual(['discover', 'claim', 'comment', 'transition'])
  })

  it('get() throws for an unknown external id', async () => {
    const provider = new FakeWorkProvider()
    await expect(provider.get('does-not-exist')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })

  it('updateDescription() mutates the stored item and getDescription() reads it back', async () => {
    const provider = new FakeWorkProvider()
    const item = makeWorkItem({ externalId: 'B-1', description: 'original' })
    provider.seed(item)

    expect(await provider.getDescription(item)).toBe('original')
    await provider.updateDescription(item, 'rewritten')
    expect(await provider.getDescription(item)).toBe('rewritten')

    expect(provider.calls.map((c) => c.op)).toEqual([
      'getDescription',
      'updateDescription',
      'getDescription',
    ])
    const update = provider.calls[1]
    expect(update && 'description' in update && update.description).toBe('rewritten')
  })

  it('getDescription() returns an empty string for an item without a description', async () => {
    const provider = new FakeWorkProvider()
    const item = makeWorkItem({ externalId: 'B-2' })
    provider.seed(item)
    expect(await provider.getDescription(item)).toBe('')
  })

  it('body access throws for an unknown item', async () => {
    const provider = new FakeWorkProvider()
    const unknown = makeWorkItem({ externalId: 'B-404' })
    await expect(provider.getDescription(unknown)).rejects.toMatchObject({
      category: 'invalid-input',
    })
    await expect(provider.updateDescription(unknown, 'x')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})
