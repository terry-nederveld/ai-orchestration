import {
  asId,
  type CheckpointContext,
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  type RunId,
  type WorkItem,
  type WorkProvider,
} from '@overture/core'
import { FakeWorkProvider, makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { WorkItemSectionCheckpointStrategy } from './work-item-section-strategy.js'

const RUN_ID: RunId = asId('run-1')

interface Fixture {
  readonly strategy: WorkItemSectionCheckpointStrategy
  readonly provider: FakeWorkProvider
  readonly item: WorkItem
}

function setup(description = 'Human-written intro.\n\nAcceptance criteria live here.'): Fixture {
  const provider = new FakeWorkProvider()
  const item = makeWorkItem({ externalId: 'ITEM-7', description })
  provider.seed(item)
  const strategy = new WorkItemSectionCheckpointStrategy({
    resolveItem: async (workItemId) => (workItemId === item.id ? { provider, item } : undefined),
  })
  return { strategy, provider, item }
}

function context(item: WorkItem, summary = 'Drafted the requirements'): CheckpointContext {
  return {
    runId: RUN_ID,
    nodeId: 'node-1',
    specRevision: 3,
    workItemId: item.id,
    summary,
  }
}

async function currentBody(provider: FakeWorkProvider, item: WorkItem): Promise<string> {
  return provider.getDescription(item)
}

describe('WorkItemSectionCheckpointStrategy', () => {
  it('rejects a context without a workItemId', async () => {
    const { strategy } = setup()
    await expect(
      strategy.checkpoint({ runId: RUN_ID, nodeId: 'node-1', specRevision: 1, summary: 'x' }),
    ).rejects.toMatchObject({ category: 'invalid-input' })
  })

  it('rejects an unknown work item', async () => {
    const { strategy, item } = setup()
    await expect(
      strategy.checkpoint({ ...context(item), workItemId: asId('missing') }),
    ).rejects.toMatchObject({ category: 'invalid-input' })
  })

  it('appends a managed status section to a body that has none', async () => {
    const { strategy, provider, item } = setup()

    const checkpoint = await strategy.checkpoint(context(item))

    expect(checkpoint.coordinates).toMatchObject({ workItemId: item.id, applied: true })
    expect(checkpoint.coordinates.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const body = await currentBody(provider, item)
    expect(body.startsWith('Human-written intro.')).toBe(true)
    expect(body).toContain(MANAGED_SECTION_BEGIN)
    expect(body).toContain(MANAGED_SECTION_END)
    expect(body).toContain('Drafted the requirements')
    expect(body).toContain('- Spec revision: 3')
    expect(body).toContain(`- run: ${RUN_ID}`)
  })

  it('replaces only the managed section, preserving human edits made between checkpoints', async () => {
    const { strategy, provider, item } = setup()
    await strategy.checkpoint(context(item, 'First status'))

    // A human edits the body around the managed section between checkpoints.
    const edited = `PRIORITY CHANGED - read this first.\n\n${await currentBody(provider, item)}\n\nHuman afterthought below the section.`
    provider.seed({ ...item, description: edited })

    await strategy.checkpoint(context(item, 'Second status'))

    const body = await currentBody(provider, item)
    expect(body).toContain('PRIORITY CHANGED - read this first.')
    expect(body).toContain('Human afterthought below the section.')
    expect(body).toContain('Second status')
    expect(body).not.toContain('First status')
    expect(body.split(MANAGED_SECTION_BEGIN)).toHaveLength(2)
    expect(body.split(MANAGED_SECTION_END)).toHaveLength(2)
  })

  it('refuses to write over damaged delimiters and comments on the item instead', async () => {
    const { strategy, provider, item } = setup()
    await strategy.checkpoint(context(item, 'First status'))

    // A human accidentally deletes the closing delimiter.
    const damaged = (await currentBody(provider, item)).replace(MANAGED_SECTION_END, '')
    provider.seed({ ...item, description: damaged })

    const checkpoint = await strategy.checkpoint(context(item, 'Second status'))

    expect(checkpoint.coordinates.applied).toBe(false)
    expect(String(checkpoint.coordinates.reason)).toContain('delimiters')
    expect(checkpoint.coordinates.contentHash).toBeUndefined()

    // The body was left untouched and a comment flags the failure.
    expect(await currentBody(provider, item)).toBe(damaged)
    const commentCall = provider.calls.find((call) => call.op === 'comment')
    expect(commentCall && 'comment' in commentCall && commentCall.comment.body).toContain(
      'could not update',
    )
    // Only the first (pre-damage) checkpoint ever wrote the body.
    expect(provider.calls.filter((call) => call.op === 'updateDescription')).toHaveLength(1)
  })

  it('restore() returns the managed content round-tripped through the provider', async () => {
    const { strategy, item } = setup()
    const checkpoint = await strategy.checkpoint(context(item, 'Latest status'))

    const restored = await strategy.restore(checkpoint)

    expect(String(restored.managedContent)).toContain('Latest status')
    expect(String(restored.managedContent)).toContain(`- run: ${RUN_ID}`)
  })

  it('restore() reports undefined managed content when humans removed the section', async () => {
    const { strategy, provider, item } = setup()
    const checkpoint = await strategy.checkpoint(context(item))
    provider.seed({ ...item, description: 'A human replaced the whole body.' })

    const restored = await strategy.restore(checkpoint)

    expect(restored.managedContent).toBeUndefined()
  })

  it('falls back to the cached item description when the provider lacks getDescription', async () => {
    const { provider, item } = setup()
    const limited: WorkProvider = {
      info: provider.info,
      detect: () => provider.detect(),
      discover: (query) => provider.discover(query),
      get: (externalId, container) => provider.get(externalId, container),
      claim: (target, claim) => provider.claim(target, claim),
      release: (target, claim) => provider.release(target, claim),
      comment: (target, comment) => provider.comment(target, comment),
      transition: (target, transition) => provider.transition(target, transition),
      listStates: (container) => provider.listStates(container),
      updateDescription: (target, description) => provider.updateDescription(target, description),
    }
    const strategy = new WorkItemSectionCheckpointStrategy({
      resolveItem: async () => ({ provider: limited, item }),
    })

    await strategy.checkpoint(context(item))

    const body = await provider.getDescription(item)
    expect(body.startsWith('Human-written intro.')).toBe(true)
    expect(body).toContain(MANAGED_SECTION_BEGIN)
  })

  it('rejects providers that cannot update descriptions', async () => {
    const { provider, item } = setup()
    const readOnly: WorkProvider = {
      info: provider.info,
      detect: () => provider.detect(),
      discover: (query) => provider.discover(query),
      get: (externalId, container) => provider.get(externalId, container),
      claim: (target, claim) => provider.claim(target, claim),
      release: (target, claim) => provider.release(target, claim),
      comment: (target, comment) => provider.comment(target, comment),
      transition: (target, transition) => provider.transition(target, transition),
      listStates: (container) => provider.listStates(container),
    }
    const strategy = new WorkItemSectionCheckpointStrategy({
      resolveItem: async () => ({ provider: readOnly, item }),
    })

    await expect(strategy.checkpoint(context(item))).rejects.toMatchObject({
      category: 'capability-mismatch',
    })
  })
})
