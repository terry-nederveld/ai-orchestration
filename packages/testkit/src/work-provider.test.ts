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

describe('FakeWorkProvider creation and linking', () => {
  it('createItem() seeds a retrievable item with sequential NEW-<n> ids and records the call', async () => {
    const provider = new FakeWorkProvider()
    const first = await provider.createItem({ title: 'First', labels: ['bug'] })
    const second = await provider.createItem({ title: 'Second' })

    expect(first.id).toBe('fake-work:NEW-1')
    expect(second.id).toBe('fake-work:NEW-2')
    expect(first).toMatchObject({
      provider: 'fake-work',
      externalId: 'NEW-1',
      title: 'First',
      labels: ['bug'],
      state: 'todo',
    })
    expect(await provider.get('NEW-1')).toEqual(first)
    expect(provider.calls.filter((c) => c.op === 'createItem')).toHaveLength(2)
  })

  it('createItem() carries description, type, and container into the item', async () => {
    const provider = new FakeWorkProvider()
    const item = await provider.createItem({
      title: 'Detailed',
      description: 'body',
      type: 'bug',
      container: 'org/repo',
    })
    expect(item).toMatchObject({
      description: 'body',
      type: 'bug',
      repository: { locator: 'org/repo' },
    })
    expect(await provider.get('NEW-1', 'org/repo')).toEqual(item)
  })

  it('createItem() materializes relateTo in the created item relationships', async () => {
    const provider = new FakeWorkProvider()
    provider.seed(makeWorkItem({ externalId: 'A-1' }))
    const item = await provider.createItem({
      title: 'Child',
      relateTo: { kind: 'child-of', targetExternalId: 'A-1' },
    })
    expect(item.relationships).toEqual([{ kind: 'child-of', targetExternalId: 'A-1' }])
    expect((await provider.get('NEW-1')).relationships).toEqual([
      { kind: 'child-of', targetExternalId: 'A-1' },
    ])
  })

  it('linkItems() appends a relationship to the stored item and records the call', async () => {
    const provider = new FakeWorkProvider()
    const item = makeWorkItem({ externalId: 'A-1' })
    provider.seed(item)

    await provider.linkItems(item, 'blocks', 'A-2')
    await provider.linkItems(item, 'relates-to', 'A-3')

    expect((await provider.get('A-1')).relationships).toEqual([
      { kind: 'blocks', targetExternalId: 'A-2' },
      { kind: 'relates-to', targetExternalId: 'A-3' },
    ])
    expect(provider.calls.filter((c) => c.op === 'linkItems')).toEqual([
      { op: 'linkItems', item, kind: 'blocks', targetExternalId: 'A-2' },
      { op: 'linkItems', item, kind: 'relates-to', targetExternalId: 'A-3' },
    ])
  })

  it('linkItems() throws for an unknown item', async () => {
    const provider = new FakeWorkProvider()
    const unknown = makeWorkItem({ externalId: 'A-404' })
    await expect(provider.linkItems(unknown, 'blocks', 'A-1')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})
