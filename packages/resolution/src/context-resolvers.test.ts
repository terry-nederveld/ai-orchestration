import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  asId,
  type ContextRequest,
  defaultAttachmentPolicy,
  defaultTraversalPolicy,
  type WorkItem,
} from '@overture/core'
import { FakeWorkProvider, makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import {
  AttachmentContextResolver,
  type AttachmentInput,
  InstructionContextResolver,
  RelationshipContextResolver,
  WorkItemContextResolver,
} from './context-resolvers.js'
import { ConventionInstructionProvider } from './instruction-providers.js'

function makeRequest(item: WorkItem, overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    runId: asId('run-1'),
    item,
    traversal: defaultTraversalPolicy,
    attachments: defaultAttachmentPolicy,
    maxTotalChars: 100_000,
    ...overrides,
  }
}

describe('WorkItemContextResolver', () => {
  it('emits a summary fragment and a metadata fragment', async () => {
    const item = makeWorkItem({
      externalId: 'ITEM-1',
      title: 'Fix login',
      description: 'Users cannot log in.',
      state: 'todo',
      type: 'bug',
      labels: ['auth', 'urgent'],
    })
    const fragments = await new WorkItemContextResolver().resolve(makeRequest(item))

    expect(fragments).toHaveLength(2)
    const [summary, details] = fragments
    expect(summary).toMatchObject({ kind: 'work-item', priority: 100 })
    expect(summary?.content).toBe('Fix login\n\nUsers cannot log in.')
    expect(summary?.provenance).toContain('ITEM-1')
    expect(details).toMatchObject({ kind: 'work-item', priority: 90 })
    expect(details?.content).toContain('State: todo')
    expect(details?.content).toContain('Type: bug')
    expect(details?.content).toContain('Labels: auth, urgent')
  })

  it('omits absent optional metadata lines', async () => {
    const item = makeWorkItem({ state: 'todo' })
    const [, details] = await new WorkItemContextResolver().resolve(makeRequest(item))
    expect(details?.content).toBe('State: todo')
  })
})

describe('RelationshipContextResolver', () => {
  function seededResolver(items: readonly WorkItem[]): {
    resolver: RelationshipContextResolver
    provider: FakeWorkProvider
  } {
    const provider = new FakeWorkProvider(items)
    return { resolver: new RelationshipContextResolver({ work: () => provider }), provider }
  }

  const active = makeWorkItem({
    externalId: 'ACTIVE',
    relationships: [
      { kind: 'child-of', targetExternalId: 'PARENT' },
      { kind: 'parent-of', targetExternalId: 'CHILD' },
      { kind: 'blocked-by', targetExternalId: 'BLOCKER' },
      { kind: 'blocks', targetExternalId: 'DEP' },
      { kind: 'relates-to', targetExternalId: 'REL' },
    ],
  })
  const neighbors = [
    makeWorkItem({ externalId: 'PARENT', title: 'The parent epic' }),
    makeWorkItem({ externalId: 'CHILD', title: 'A subtask' }),
    makeWorkItem({ externalId: 'BLOCKER', title: 'The blocker' }),
    makeWorkItem({ externalId: 'DEP', title: 'The dependency' }),
    makeWorkItem({ externalId: 'REL', title: 'Related work' }),
  ]

  it('resolves 1-up/1-down plus blockers and dependencies by default', async () => {
    const { resolver } = seededResolver([active, ...neighbors])
    const fragments = await resolver.resolve(makeRequest(active))

    expect(fragments.map((f) => [f.kind, f.priority])).toEqual([
      ['parent', 70],
      ['child', 60],
      ['blocker', 65],
      ['dependency', 65],
    ])
    const parent = fragments.find((f) => f.kind === 'parent')
    expect(parent?.title).toBe('Parent PARENT: The parent epic')
    expect(parent?.provenance).toContain('PARENT')
  })

  it('includes relates-to targets only when includeRelated is set', async () => {
    const { resolver } = seededResolver([active, ...neighbors])
    const fragments = await resolver.resolve(
      makeRequest(active, { traversal: { ...defaultTraversalPolicy, includeRelated: true } }),
    )
    const related = fragments.find((f) => f.kind === 'related')
    expect(related).toMatchObject({ priority: 40, title: 'Related REL: Related work' })
  })

  it('traverses multiple parent levels iteratively', async () => {
    const parent = makeWorkItem({
      externalId: 'PARENT',
      title: 'Mid epic',
      relationships: [{ kind: 'child-of', targetExternalId: 'GRANDPARENT' }],
    })
    const grandparent = makeWorkItem({ externalId: 'GRANDPARENT', title: 'Top epic' })
    const item = makeWorkItem({
      externalId: 'ACTIVE',
      relationships: [{ kind: 'child-of', targetExternalId: 'PARENT' }],
    })
    const { resolver } = seededResolver([item, parent, grandparent])

    const oneLevel = await resolver.resolve(makeRequest(item))
    expect(oneLevel.filter((f) => f.kind === 'parent')).toHaveLength(1)

    const twoLevels = await resolver.resolve(
      makeRequest(item, { traversal: { ...defaultTraversalPolicy, parentLevels: 2 } }),
    )
    expect(twoLevels.filter((f) => f.kind === 'parent').map((f) => f.title)).toEqual([
      'Parent PARENT: Mid epic',
      'Parent GRANDPARENT: Top epic',
    ])
  })

  it('caps total fetches at 20', async () => {
    const blockers = Array.from({ length: 25 }, (_, i) => makeWorkItem({ externalId: `B-${i}` }))
    const item = makeWorkItem({
      externalId: 'ACTIVE',
      relationships: blockers.map((b) => ({
        kind: 'blocked-by' as const,
        targetExternalId: b.externalId,
      })),
    })
    const { resolver, provider } = seededResolver([item, ...blockers])
    const fragments = await resolver.resolve(makeRequest(item))

    expect(fragments).toHaveLength(20)
    expect(provider.calls.filter((c) => c.op === 'get')).toHaveLength(20)
  })

  it('skips fetch failures without failing the resolution', async () => {
    const item = makeWorkItem({
      externalId: 'ACTIVE',
      relationships: [
        { kind: 'blocked-by', targetExternalId: 'MISSING' },
        { kind: 'blocked-by', targetExternalId: 'BLOCKER' },
      ],
    })
    const { resolver } = seededResolver([item, makeWorkItem({ externalId: 'BLOCKER' })])
    const fragments = await resolver.resolve(makeRequest(item))

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.title).toContain('BLOCKER')
  })

  it('returns nothing when no work provider is registered', async () => {
    const resolver = new RelationshipContextResolver({ work: () => undefined })
    expect(await resolver.resolve(makeRequest(active))).toEqual([])
  })

  it('truncates related item descriptions at 2000 characters', async () => {
    const parent = makeWorkItem({ externalId: 'PARENT', description: 'd'.repeat(3000) })
    const item = makeWorkItem({
      externalId: 'ACTIVE',
      relationships: [{ kind: 'child-of', targetExternalId: 'PARENT' }],
    })
    const { resolver } = seededResolver([item, parent])
    const [fragment] = await resolver.resolve(makeRequest(item))

    expect(fragment?.content).toContain('[truncated]')
    expect(fragment?.content.length).toBeLessThan(2200)
  })
})

describe('InstructionContextResolver', () => {
  it('merges discovered instructions into a single high-priority fragment', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'overture-resolution-'))
    try {
      await fs.writeFile(path.join(repo, 'CLAUDE.md'), '# Repo rules')
      const resolver = new InstructionContextResolver({
        providers: [new ConventionInstructionProvider()],
        repositoryPaths: () => [repo],
      })
      const fragments = await resolver.resolve(makeRequest(makeWorkItem()))

      expect(fragments).toHaveLength(1)
      expect(fragments[0]).toMatchObject({
        kind: 'instructions',
        priority: 95,
        provenance: 'instruction-discovery',
      })
      expect(fragments[0]?.content).toContain('# Repo rules')
      expect(fragments[0]?.content).toContain('CLAUDE.md')
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it('isolates provider failures and emits nothing when no documents are found', async () => {
    const failing = {
      id: 'failing',
      discover: async () => {
        throw new Error('boom')
      },
    }
    const resolver = new InstructionContextResolver({
      providers: [failing],
      repositoryPaths: () => [],
    })
    expect(await resolver.resolve(makeRequest(makeWorkItem()))).toEqual([])
  })
})

describe('AttachmentContextResolver', () => {
  function makeAttachment(
    name: string,
    overrides: Partial<Omit<AttachmentInput, 'text'>> & { readonly content?: string } = {},
  ): AttachmentInput {
    const content = overrides.content ?? 'attachment body'
    return {
      name,
      type: overrides.type ?? 'text/plain',
      sizeBytes: overrides.sizeBytes ?? content.length,
      text: async () => content,
    }
  }

  const enabledPolicy = { ...defaultAttachmentPolicy, enabled: true }

  it('produces nothing when attachments are disabled, without calling the port', async () => {
    let called = false
    const resolver = new AttachmentContextResolver({
      fetchAttachments: async () => {
        called = true
        return [makeAttachment('notes.txt')]
      },
    })
    const fragments = await resolver.resolve(makeRequest(makeWorkItem()))
    expect(fragments).toEqual([])
    expect(called).toBe(false)
  })

  it('emits fragments for allowed attachments when enabled', async () => {
    const resolver = new AttachmentContextResolver({
      fetchAttachments: async () => [makeAttachment('notes.txt', { content: 'hello' })],
    })
    const fragments = await resolver.resolve(
      makeRequest(makeWorkItem({ externalId: 'ITEM-9' }), { attachments: enabledPolicy }),
    )
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toMatchObject({
      kind: 'attachment',
      priority: 30,
      title: 'Attachment: notes.txt',
      content: 'hello',
    })
    expect(fragments[0]?.provenance).toContain('ITEM-9')
  })

  it('filters disallowed types and oversize attachments and caps the count', async () => {
    const resolver = new AttachmentContextResolver({
      fetchAttachments: async () => [
        makeAttachment('image.png', { type: 'image/png' }),
        makeAttachment('huge.txt', { sizeBytes: 2 * 1024 * 1024 }),
        makeAttachment('a.txt'),
        makeAttachment('b.txt'),
        makeAttachment('c.txt'),
      ],
    })
    const fragments = await resolver.resolve(
      makeRequest(makeWorkItem(), { attachments: { ...enabledPolicy, maxAttachments: 2 } }),
    )
    expect(fragments.map((f) => f.title)).toEqual(['Attachment: a.txt', 'Attachment: b.txt'])
  })

  it('truncates extracted text at maxExtractedChars', async () => {
    const resolver = new AttachmentContextResolver({
      fetchAttachments: async () => [makeAttachment('big.txt', { content: 'x'.repeat(500) })],
    })
    const fragments = await resolver.resolve(
      makeRequest(makeWorkItem(), { attachments: { ...enabledPolicy, maxExtractedChars: 100 } }),
    )
    expect(fragments[0]?.content).toBe(`${'x'.repeat(100)}\n[truncated]`)
  })

  it('skips attachments whose extraction fails', async () => {
    const broken: AttachmentInput = {
      name: 'broken.txt',
      type: 'text/plain',
      sizeBytes: 10,
      text: async () => {
        throw new Error('unreadable')
      },
    }
    const resolver = new AttachmentContextResolver({
      fetchAttachments: async () => [broken, makeAttachment('ok.txt')],
    })
    const fragments = await resolver.resolve(
      makeRequest(makeWorkItem(), { attachments: enabledPolicy }),
    )
    expect(fragments.map((f) => f.title)).toEqual(['Attachment: ok.txt'])
  })

  it('defaults to a noop attachment port', async () => {
    const resolver = new AttachmentContextResolver()
    const fragments = await resolver.resolve(
      makeRequest(makeWorkItem(), { attachments: enabledPolicy }),
    )
    expect(fragments).toEqual([])
  })
})
