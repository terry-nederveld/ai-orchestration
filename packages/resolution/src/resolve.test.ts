import {
  asId,
  type ContextFragment,
  type ContextRequest,
  type ContextResolver,
  defaultAttachmentPolicy,
  defaultTraversalPolicy,
  type Logger,
  noopLogger,
} from '@overture/core'
import { makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { resolveContext } from './resolve.js'

function stubResolver(id: string, fragments: readonly ContextFragment[]): ContextResolver {
  return { id, resolve: async () => fragments }
}

function fragment(overrides: Partial<ContextFragment>): ContextFragment {
  return {
    resolverId: 'stub',
    kind: 'work-item',
    title: 'Fragment',
    content: 'content',
    priority: 50,
    provenance: 'test',
    ...overrides,
  }
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    runId: asId('run-1'),
    item: makeWorkItem(),
    traversal: defaultTraversalPolicy,
    attachments: defaultAttachmentPolicy,
    maxTotalChars: 100_000,
    ...overrides,
  }
}

describe('resolveContext', () => {
  it('concatenates fragments from resolvers in order', async () => {
    const bundle = await resolveContext(
      [
        stubResolver('a', [fragment({ title: 'first', priority: 50 })]),
        stubResolver('b', [fragment({ title: 'second', priority: 50 })]),
      ],
      makeRequest(),
    )
    expect(bundle.fragments.map((f) => f.title)).toEqual(['first', 'second'])
    expect(bundle.totalChars).toBe('content'.length * 2)
  })

  it('applies the request character budget, dropping low-priority fragments', async () => {
    const bundle = await resolveContext(
      [
        stubResolver('a', [
          fragment({ title: 'low', priority: 10, content: 'x'.repeat(60) }),
          fragment({ title: 'high', priority: 90, content: 'y'.repeat(60) }),
        ]),
      ],
      makeRequest({ maxTotalChars: 100 }),
    )
    expect(bundle.fragments.map((f) => f.title)).toEqual(['high'])
    expect(bundle.excluded.map((e) => e.fragment.title)).toEqual(['low'])
  })

  it('isolates resolver failures and logs them', async () => {
    const warnings: string[] = []
    const logger: Logger = {
      ...noopLogger,
      warn: (message) => {
        warnings.push(message)
      },
    }
    const failing: ContextResolver = {
      id: 'failing',
      resolve: async () => {
        throw new Error('boom')
      },
    }
    const bundle = await resolveContext(
      [failing, stubResolver('ok', [fragment({ title: 'survivor' })])],
      makeRequest(),
      { logger },
    )
    expect(bundle.fragments.map((f) => f.title)).toEqual(['survivor'])
    expect(warnings).toEqual(['context resolver failed'])
  })
})
