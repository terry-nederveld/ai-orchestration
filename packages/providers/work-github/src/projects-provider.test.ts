import { asId } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { GitHubProjectsWorkProvider } from './projects-provider.js'
import { fakeFetch, jsonResponse, routedFetch, textErrorResponse } from './test-helpers.js'

function makeProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof GitHubProjectsWorkProvider>[0]> = {},
) {
  return new GitHubProjectsWorkProvider({
    token: async () => 'ghp_test',
    owner: 'acme',
    ownerType: 'organization',
    projectNumber: 7,
    fetchImpl,
    ...overrides,
  })
}

function graphqlBody(init: RequestInit): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(init.body))
}

const issueItemNode = {
  id: 'item_1',
  fieldValues: {
    nodes: [{ name: 'In Progress', field: { name: 'Status' } }],
  },
  content: {
    __typename: 'Issue',
    id: 'issue_node_1',
    number: 5,
    title: 'Fix the thing',
    body: 'Details',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/5',
    labels: { nodes: [{ name: 'bug' }] },
    assignees: { nodes: [{ login: 'alice' }] },
    repository: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } },
  },
}

const draftItemNode = {
  id: 'item_2',
  fieldValues: { nodes: [{ name: 'Todo', field: { name: 'Status' } }] },
  content: { __typename: 'DraftIssue', title: 'Draft idea', body: null },
}

describe('GitHubProjectsWorkProvider.discover', () => {
  it('maps project items, extracting status from fieldValues', async () => {
    const fetchImpl = routedFetch((_url, init) => {
      const body = graphqlBody(init)
      expect(body.query).toContain('projectV2')
      return jsonResponse(200, {
        data: {
          organization: {
            projectV2: {
              id: 'project_1',
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [issueItemNode, draftItemNode],
              },
            },
          },
        },
      })
    })
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({})

    expect(items).toHaveLength(2)
    const issueItem = items.find((i) => i.type === 'issue')
    expect(issueItem).toMatchObject({
      id: 'github-projects:item_1',
      externalId: 'item_1',
      title: 'Fix the thing',
      description: 'Details',
      state: 'In Progress',
      labels: ['bug'],
      assignees: [{ id: 'alice', displayName: 'alice' }],
      repository: { locator: 'acme/widgets', defaultBranch: 'main' },
      metadata: { projectItemId: 'item_1', contentNodeId: 'issue_node_1', number: 5 },
      url: 'https://github.com/acme/widgets/issues/5',
    })

    const draftItem = items.find((i) => i.type === 'draft')
    expect(draftItem).toMatchObject({
      id: 'github-projects:item_2',
      externalId: 'item_2',
      title: 'Draft idea',
      state: 'Todo',
      labels: [],
    })
  })

  it('filters by query.states client-side', async () => {
    const fetchImpl = routedFetch(() =>
      jsonResponse(200, {
        data: {
          organization: {
            projectV2: {
              id: 'project_1',
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [issueItemNode, draftItemNode],
              },
            },
          },
        },
      }),
    )
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ states: ['Todo'] })
    expect(items.map((i) => i.externalId)).toEqual(['item_2'])
  })

  it('follows GraphQL pageInfo cursors up to the requested limit', async () => {
    let call = 0
    const fetchImpl = routedFetch((_url, init) => {
      call += 1
      const body = graphqlBody(init)
      const cursor = body.variables.cursor
      if (call === 1) {
        expect(cursor).toBeNull()
        return jsonResponse(200, {
          data: {
            organization: {
              projectV2: {
                id: 'p',
                items: {
                  pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
                  nodes: [issueItemNode],
                },
              },
            },
          },
        })
      }
      expect(cursor).toBe('CURSOR_1')
      return jsonResponse(200, {
        data: {
          organization: {
            projectV2: {
              id: 'p',
              items: {
                pageInfo: { hasNextPage: true, endCursor: 'CURSOR_2' },
                nodes: [draftItemNode],
              },
            },
          },
        },
      })
    })
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ limit: 2 })
    expect(items).toHaveLength(2)
    expect(call).toBe(2)
  })

  it('uses the "user" owner field for ownerType: user', async () => {
    const fetchImpl = routedFetch((_url, init) => {
      const body = graphqlBody(init)
      expect(body.query).toContain('user(login: $login)')
      expect(body.query).not.toContain('organization(login: $login)')
      return jsonResponse(200, {
        data: {
          user: {
            projectV2: {
              id: 'p',
              items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      })
    })
    const provider = makeProvider(fetchImpl, { ownerType: 'user' })
    await provider.discover({})
  })
})

describe('GitHubProjectsWorkProvider.transition', () => {
  it('resolves the status field/option ids and sends a singleSelectOptionId mutation', async () => {
    const fetchImpl = routedFetch((_url, init) => {
      const body = graphqlBody(init)
      if (body.query.includes('field(name:')) {
        return jsonResponse(200, {
          data: {
            organization: {
              projectV2: {
                id: 'project_1',
                field: {
                  id: 'field_1',
                  name: 'Status',
                  options: [
                    { id: 'opt_todo', name: 'Todo' },
                    { id: 'opt_progress', name: 'In Progress' },
                    { id: 'opt_done', name: 'Done' },
                  ],
                },
              },
            },
          },
        })
      }
      if (body.query.includes('updateProjectV2ItemFieldValue')) {
        expect(body.variables).toEqual({
          projectId: 'project_1',
          itemId: 'item_1',
          fieldId: 'field_1',
          optionId: 'opt_done',
        })
        return jsonResponse(200, {
          data: { updateProjectV2ItemFieldValue: { clientMutationId: null } },
        })
      }
      throw new Error(`unexpected GraphQL query: ${body.query}`)
    })
    const provider = makeProvider(fetchImpl)
    await provider.transition(
      {
        id: asId('github-projects:item_1'),
        provider: 'github-projects',
        externalId: 'item_1',
        title: 'x',
        state: 'In Progress',
        labels: [],
        assignees: [],
        relationships: [],
        metadata: {},
      },
      { targetState: 'Done' },
    )
  })

  it('rejects an unknown status option', async () => {
    const fetchImpl = routedFetch(() =>
      jsonResponse(200, {
        data: {
          organization: {
            projectV2: {
              id: 'p',
              field: { id: 'f', name: 'Status', options: [{ id: 'o1', name: 'Todo' }] },
            },
          },
        },
      }),
    )
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.transition(
        {
          id: asId('github-projects:item_1'),
          provider: 'github-projects',
          externalId: 'item_1',
          title: 'x',
          state: 'Todo',
          labels: [],
          assignees: [],
          relationships: [],
          metadata: {},
        },
        { targetState: 'Nonexistent' },
      ),
    ).rejects.toMatchObject({ category: 'invalid-input' })
  })
})

describe('GitHubProjectsWorkProvider claim / release / comment', () => {
  it('claims via a comment marker on the underlying issue and is idempotent for the same claimant', async () => {
    const comments: string[] = []
    const fetchImpl = routedFetch((_url, init) => {
      const body = graphqlBody(init)
      if (body.query.includes('comments(last:')) {
        return jsonResponse(200, {
          data: { node: { comments: { nodes: comments.map((body) => ({ body })) } } },
        })
      }
      if (body.query.includes('addComment')) {
        comments.push(String(body.variables.body))
        return jsonResponse(200, { data: { addComment: { clientMutationId: null } } })
      }
      throw new Error(`unexpected query: ${body.query}`)
    })
    const provider = makeProvider(fetchImpl)
    const item = {
      id: asId('github-projects:item_1'),
      provider: 'github-projects',
      externalId: 'item_1',
      title: 'x',
      state: 'Todo',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: { contentNodeId: 'issue_node_1' },
    }

    const claimA = { claimant: 'agent-a', runId: 'run-1' }
    expect((await provider.claim(item, claimA)).outcome).toBe('claimed')
    expect((await provider.claim(item, claimA)).outcome).toBe('claimed')

    const claimB = { claimant: 'agent-b', runId: 'run-2' }
    const result = await provider.claim(item, claimB)
    expect(result.outcome).toBe('already-claimed')
  })

  it('reports draft items as not-claimable and rejects comment()', async () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch)
    const draft = {
      id: asId('github-projects:item_2'),
      provider: 'github-projects',
      externalId: 'item_2',
      title: 'draft',
      state: 'Todo',
      type: 'draft',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    const claimResult = await provider.claim(draft, { claimant: 'agent-a', runId: 'run-1' })
    expect(claimResult.outcome).toBe('not-claimable')
    await expect(provider.comment(draft, { body: 'hi' })).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})

describe('GitHubProjectsWorkProvider error mapping', () => {
  it('maps a top-level GraphQL errors array with type RATE_LIMITED', async () => {
    const fetchImpl = routedFetch(() =>
      jsonResponse(200, { errors: [{ message: 'API rate limit exceeded', type: 'RATE_LIMITED' }] }),
    )
    const provider = makeProvider(fetchImpl)
    await expect(provider.discover({})).rejects.toMatchObject({
      category: 'rate-limit',
      retryable: true,
    })
  })

  it('maps an HTTP-level 401 to auth-expired', async () => {
    const fetchImpl = routedFetch(() => textErrorResponse(401, '{"message":"Bad credentials"}'))
    const provider = makeProvider(fetchImpl)
    await expect(provider.discover({})).rejects.toMatchObject({ category: 'auth-expired' })
  })

  it('maps a network failure to a retryable network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const provider = makeProvider(fetchImpl)
    await expect(provider.discover({})).rejects.toMatchObject({
      category: 'network',
      retryable: true,
    })
  })
})

describe('GitHubProjectsWorkProvider.detect', () => {
  it('reports unauthenticated when no token resolves', async () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch, {
      token: async () => undefined,
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: false, authenticated: false })
  })

  it('reports available when the status field resolves', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, {
        data: {
          organization: {
            projectV2: {
              id: 'p',
              field: { id: 'f', name: 'Status', options: [{ id: 'o1', name: 'Todo' }] },
            },
          },
        },
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: true, authenticated: true })
  })
})
