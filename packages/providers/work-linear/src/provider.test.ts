import type { OrchestratorError } from '@overture/core'
import { makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { LinearWorkProvider } from './provider.js'
import { fakeFetch, graphqlBody, jsonResponse, textErrorResponse } from './test-helpers.js'

const ISSUE_FIXTURE = {
  id: 'internal-uuid-1',
  identifier: 'ENG-123',
  title: 'Fix the thing',
  description: 'details',
  state: { name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
  assignee: null,
  priority: 2,
  url: 'https://linear.app/acme/issue/ENG-123',
  updatedAt: '2026-08-01T12:00:00.000Z',
  team: { key: 'ENG' },
}

function provider(fetchImpl: typeof fetch, overrides: Partial<{ teamKey: string }> = {}) {
  return new LinearWorkProvider({
    apiKey: async () => 'lin_api_test123',
    teamKey: overrides.teamKey ?? 'ENG',
    fetchImpl,
  })
}

describe('LinearWorkProvider request shape', () => {
  it('sends the raw API key in the Authorization header for authKind "api-key" (default)', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { data: { viewer: { id: 'u1', name: 'A' } } }),
    ])
    await provider(fetchImpl).detect()
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'lin_api_test123' })
  })

  it('sends "Bearer <token>" in the Authorization header for authKind "oauth"', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { data: { viewer: { id: 'u1', name: 'A' } } }),
    ])
    const p = new LinearWorkProvider({
      apiKey: async () => 'oauth-token',
      authKind: 'oauth',
      fetchImpl,
    })
    await p.detect()
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer oauth-token' })
  })

  it('posts to the single /graphql endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { data: { viewer: { id: 'u1', name: 'A' } } }),
    ])
    await provider(fetchImpl).detect()
    expect(calls[0]?.url).toBe('https://api.linear.app/graphql')
    expect(calls[0]?.init.method).toBe('POST')
  })
})

describe('LinearWorkProvider.detect', () => {
  it('reports unauthenticated when no API key is configured', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const p = new LinearWorkProvider({ apiKey: async () => undefined, fetchImpl })
    const result = await p.detect()
    expect(result).toEqual({
      installed: true,
      authenticated: false,
      available: false,
      authenticationKind: 'api-key',
      detail: 'no Linear API key configured',
    })
    expect(calls).toHaveLength(0)
  })

  it('queries viewer and reports available on success', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { data: { viewer: { id: 'u1', name: 'A' } } }),
    ])
    const result = await provider(fetchImpl).detect()
    expect(result).toEqual({
      installed: true,
      authenticated: true,
      available: true,
      authenticationKind: 'api-key',
    })
  })

  it('reports unauthenticated with a detail message on failure', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(401, 'unauthorized')])
    const result = await provider(fetchImpl).detect()
    expect(result.authenticated).toBe(false)
    expect(result.available).toBe(false)
    expect(result.detail).toContain('unauthorized')
  })
})

describe('LinearWorkProvider.discover', () => {
  it('sends the Issues query with team filter and default limit of 50', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({})
    const body = graphqlBody(calls[0])
    expect(body.query).toContain('query Issues')
    expect(body.variables).toEqual({ filter: { team: { key: { eq: 'ENG' } } }, first: 50 })
  })

  it('query.container overrides the configured teamKey', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ container: 'OPS' })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toEqual({ team: { key: { eq: 'OPS' } } })
  })

  it('translates states into a state.name.in filter clause', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ states: ['Todo', 'In Progress'] })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({
      state: { name: { in: ['Todo', 'In Progress'] } },
    })
  })

  it('translates labelsInclude into labels.some.name.in', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ labelsInclude: ['bug'] })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({ labels: { some: { name: { in: ['bug'] } } } })
  })

  it('translates labelsExclude into labels.every.name.nin', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ labelsExclude: ['wontfix'] })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({
      labels: { every: { name: { nin: ['wontfix'] } } },
    })
  })

  it('combines labelsInclude and labelsExclude under "and" to avoid colliding on the labels key', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ labelsInclude: ['bug'], labelsExclude: ['wontfix'] })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({
      and: [
        { labels: { some: { name: { in: ['bug'] } } } },
        { labels: { every: { name: { nin: ['wontfix'] } } } },
      ],
    })
  })

  it('translates assignee "unassigned" into assignee.null', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ assignee: 'unassigned' })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({ assignee: { null: true } })
  })

  it('translates a concrete assignee id into assignee.id.eq', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ assignee: 'user-42' })
    const body = graphqlBody(calls[0])
    expect(body.variables.filter).toMatchObject({ assignee: { id: { eq: 'user-42' } } })
  })

  it('passes query.limit through as the first variable', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issues: { nodes: [] } } })])
    await provider(fetchImpl).discover({ limit: 5 })
    const body = graphqlBody(calls[0])
    expect(body.variables.first).toBe(5)
  })

  it('maps returned issue nodes to WorkItems', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { data: { issues: { nodes: [ISSUE_FIXTURE] } } }),
    ])
    const items = await provider(fetchImpl).discover({})
    expect(items).toHaveLength(1)
    expect(items[0]?.externalId).toBe('ENG-123')
    expect(items[0]?.priority).toBe('high')
  })
})

describe('LinearWorkProvider.get', () => {
  it('sends the IssueGet query with the human identifier', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { data: { issue: ISSUE_FIXTURE } })])
    const item = await provider(fetchImpl).get('ENG-123')
    const body = graphqlBody(calls[0])
    expect(body.query).toContain('query IssueGet')
    expect(body.variables).toEqual({ id: 'ENG-123' })
    expect(item.title).toBe('Fix the thing')
  })

  it('throws invalid-input when the issue is not found', async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { data: { issue: null } })])
    await expect(provider(fetchImpl).get('ENG-999')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})

describe('LinearWorkProvider.claim', () => {
  const item = makeWorkItem({
    provider: 'linear',
    externalId: 'ENG-123',
    title: 'Fix the thing',
    state: 'Todo',
    metadata: { linearId: 'internal-uuid-1', teamKey: 'ENG' },
  })

  const claim = { claimant: 'agent-a', runId: 'run-1' }

  function teamResponse(labels: { id: string; name: string }[] = []) {
    return jsonResponse(200, {
      data: { team: { id: 'team-1', states: { nodes: [] }, labels: { nodes: labels } } },
    })
  }

  it('creates the claim label when missing, then labels and comments the issue', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse([]),
      jsonResponse(200, {
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: 'label-claim', name: 'overture-claimed' },
          },
        },
      }),
      jsonResponse(200, {
        data: { issue: { id: 'internal-uuid-1', labels: { nodes: [] }, comments: { nodes: [] } } },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
      jsonResponse(200, { data: { commentCreate: { success: true } } }),
    ])
    const result = await provider(fetchImpl).claim(item, claim)
    expect(result).toEqual({ outcome: 'claimed' })

    const createBody = graphqlBody(calls[1])
    expect(createBody.query).toContain('mutation IssueLabelCreate')
    expect(createBody.variables).toEqual({ input: { name: 'overture-claimed', teamId: 'team-1' } })

    const updateBody = graphqlBody(calls[3])
    expect(updateBody.query).toContain('mutation IssueUpdate')
    expect(updateBody.variables).toEqual({
      id: 'internal-uuid-1',
      input: { labelIds: ['label-claim'] },
    })

    const commentBody = graphqlBody(calls[4])
    expect(commentBody.query).toContain('mutation CommentCreate')
    expect(commentBody.variables).toEqual({
      input: { issueId: 'internal-uuid-1', body: 'Claimed by agent-a (run run-1)' },
    })
  })

  it('reuses an existing claim label instead of creating a new one', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse([{ id: 'label-claim', name: 'overture-claimed' }]),
      jsonResponse(200, {
        data: { issue: { id: 'internal-uuid-1', labels: { nodes: [] }, comments: { nodes: [] } } },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
      jsonResponse(200, { data: { commentCreate: { success: true } } }),
    ])
    await provider(fetchImpl).claim(item, claim)
    // No issueLabelCreate call: team query -> claim-state query -> issueUpdate -> commentCreate.
    expect(calls).toHaveLength(4)
    expect(graphqlBody(calls[1]).query).toContain('query IssueClaimState')
  })

  it('is idempotent when the same claimant re-claims an issue that already has the label', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse([{ id: 'label-claim', name: 'overture-claimed' }]),
      jsonResponse(200, {
        data: {
          issue: {
            id: 'internal-uuid-1',
            labels: { nodes: [{ id: 'label-claim', name: 'overture-claimed' }] },
            comments: { nodes: [{ body: 'Claimed by agent-a (run run-1)' }] },
          },
        },
      }),
    ])
    const result = await provider(fetchImpl).claim(item, claim)
    expect(result).toEqual({ outcome: 'claimed' })
    expect(calls).toHaveLength(2) // no mutation calls: team + claim-state only
  })

  it('returns already-claimed when a different claimant holds the label', async () => {
    const { fetchImpl } = fakeFetch([
      teamResponse([{ id: 'label-claim', name: 'overture-claimed' }]),
      jsonResponse(200, {
        data: {
          issue: {
            id: 'internal-uuid-1',
            labels: { nodes: [{ id: 'label-claim', name: 'overture-claimed' }] },
            comments: { nodes: [{ body: 'Claimed by agent-b (run run-2)' }] },
          },
        },
      }),
    ])
    const result = await provider(fetchImpl).claim(item, claim)
    expect(result).toEqual({ outcome: 'already-claimed', detail: 'claimed by "agent-b"' })
  })

  it('returns already-claimed with a generic detail when the label is present but no marker comment matches', async () => {
    const { fetchImpl } = fakeFetch([
      teamResponse([{ id: 'label-claim', name: 'overture-claimed' }]),
      jsonResponse(200, {
        data: {
          issue: {
            id: 'internal-uuid-1',
            labels: { nodes: [{ id: 'label-claim', name: 'overture-claimed' }] },
            comments: { nodes: [{ body: 'unrelated comment' }] },
          },
        },
      }),
    ])
    const result = await provider(fetchImpl).claim(item, claim)
    expect(result).toEqual({ outcome: 'already-claimed', detail: 'claim label already present' })
  })

  it('uses a custom claimLabelName when configured', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse([]),
      jsonResponse(200, {
        data: {
          issueLabelCreate: { success: true, issueLabel: { id: 'label-x', name: 'agent-working' } },
        },
      }),
      jsonResponse(200, {
        data: { issue: { id: 'internal-uuid-1', labels: { nodes: [] }, comments: { nodes: [] } } },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
      jsonResponse(200, { data: { commentCreate: { success: true } } }),
    ])
    const p = new LinearWorkProvider({
      apiKey: async () => 'key',
      teamKey: 'ENG',
      fetchImpl,
      claimLabelName: 'agent-working',
    })
    await p.claim(item, claim)
    expect(graphqlBody(calls[1]).variables).toEqual({
      input: { name: 'agent-working', teamId: 'team-1' },
    })
  })

  it('throws invalid-input when the work item carries no team key', async () => {
    const { fetchImpl } = fakeFetch([])
    const p = new LinearWorkProvider({ apiKey: async () => 'key', fetchImpl })
    const itemWithoutTeam = { ...item, metadata: { linearId: 'internal-uuid-1' } }
    await expect(p.claim(itemWithoutTeam, claim)).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})

describe('LinearWorkProvider.release', () => {
  const item = makeWorkItem({
    provider: 'linear',
    externalId: 'ENG-123',
    title: 'Fix the thing',
    state: 'Todo',
    labels: ['overture-claimed'],
    metadata: { linearId: 'internal-uuid-1', teamKey: 'ENG' },
  })
  const claim = { claimant: 'agent-a', runId: 'run-1' }

  it('removes the claim label id from the issue', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: { nodes: [] },
            labels: { nodes: [{ id: 'label-claim', name: 'overture-claimed' }] },
          },
        },
      }),
      jsonResponse(200, {
        data: {
          issue: {
            id: 'internal-uuid-1',
            labels: {
              nodes: [
                { id: 'label-claim', name: 'overture-claimed' },
                { id: 'label-bug', name: 'bug' },
              ],
            },
            comments: { nodes: [] },
          },
        },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
    ])
    await provider(fetchImpl).release(item, claim)
    const updateBody = graphqlBody(calls[2])
    expect(updateBody.variables).toEqual({
      id: 'internal-uuid-1',
      input: { labelIds: ['label-bug'] },
    })
  })

  it('is a no-op when the claim label was never created for the team', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: { team: { id: 'team-1', states: { nodes: [] }, labels: { nodes: [] } } },
      }),
    ])
    await provider(fetchImpl).release(item, claim)
    expect(calls).toHaveLength(1) // only the team lookup; no claim-state fetch or mutation
  })

  it('is a no-op when the issue does not currently carry the claim label', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: { nodes: [] },
            labels: { nodes: [{ id: 'label-claim', name: 'overture-claimed' }] },
          },
        },
      }),
      jsonResponse(200, {
        data: { issue: { id: 'internal-uuid-1', labels: { nodes: [] }, comments: { nodes: [] } } },
      }),
    ])
    await provider(fetchImpl).release(item, claim)
    expect(calls).toHaveLength(2) // no issueUpdate mutation
  })
})

describe('LinearWorkProvider.transition', () => {
  const item = makeWorkItem({
    provider: 'linear',
    externalId: 'ENG-123',
    title: 'Fix the thing',
    state: 'Todo',
    metadata: { linearId: 'internal-uuid-1', teamKey: 'ENG' },
  })

  it('resolves the target state name to its internal id and updates the issue', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: {
              nodes: [
                { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                { id: 'state-in-progress', name: 'In Progress', type: 'started' },
              ],
            },
            labels: { nodes: [] },
          },
        },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
    ])
    await provider(fetchImpl).transition(item, { targetState: 'In Progress' })
    const body = graphqlBody(calls[1])
    expect(body.query).toContain('mutation IssueUpdate')
    expect(body.variables).toEqual({
      id: 'internal-uuid-1',
      input: { stateId: 'state-in-progress' },
    })
  })

  it('also posts a comment when transition.comment is provided', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: { nodes: [{ id: 'state-done', name: 'Done', type: 'completed' }] },
            labels: { nodes: [] },
          },
        },
      }),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
      jsonResponse(200, { data: { commentCreate: { success: true } } }),
    ])
    await provider(fetchImpl).transition(item, { targetState: 'Done', comment: 'shipped it' })
    const commentBody = graphqlBody(calls[2])
    expect(commentBody.variables).toEqual({
      input: { issueId: 'internal-uuid-1', body: 'shipped it' },
    })
  })

  it('throws invalid-input listing available state names for an unknown target state', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: {
              nodes: [
                { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                { id: 'state-done', name: 'Done', type: 'completed' },
              ],
            },
            labels: { nodes: [] },
          },
        },
      }),
    ])
    await expect(provider(fetchImpl).transition(item, { targetState: 'Bogus' })).rejects.toThrow(
      /Unknown state "Bogus".*Available states: Todo, Done/,
    )
  })
})

describe('LinearWorkProvider.comment', () => {
  const item = makeWorkItem({
    provider: 'linear',
    externalId: 'ENG-123',
    title: 'Fix the thing',
    state: 'Todo',
    metadata: { linearId: 'internal-uuid-1' },
  })

  it('sends commentCreate with the issue id and body', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { data: { commentCreate: { success: true } } }),
    ])
    await provider(fetchImpl).comment(item, { body: 'hello **world**' })
    const body = graphqlBody(calls[0])
    expect(body.query).toContain('mutation CommentCreate')
    expect(body.variables).toEqual({
      input: { issueId: 'internal-uuid-1', body: 'hello **world**' },
    })
  })
})

describe('LinearWorkProvider.listStates', () => {
  it('maps team states with category derived from Linear state type', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: {
          team: {
            id: 'team-1',
            states: {
              nodes: [
                { id: 's1', name: 'Triage', type: 'triage' },
                { id: 's2', name: 'Backlog', type: 'backlog' },
                { id: 's3', name: 'Todo', type: 'unstarted' },
                { id: 's4', name: 'In Progress', type: 'started' },
                { id: 's5', name: 'Done', type: 'completed' },
                { id: 's6', name: 'Canceled', type: 'canceled' },
              ],
            },
            labels: { nodes: [] },
          },
        },
      }),
    ])
    const states = await provider(fetchImpl).listStates()
    expect(states).toEqual([
      { id: 'Triage', name: 'Triage', category: 'todo' },
      { id: 'Backlog', name: 'Backlog', category: 'todo' },
      { id: 'Todo', name: 'Todo', category: 'todo' },
      { id: 'In Progress', name: 'In Progress', category: 'in-progress' },
      { id: 'Done', name: 'Done', category: 'done' },
      { id: 'Canceled', name: 'Canceled', category: 'other' },
    ])
    expect(graphqlBody(calls[0]).variables).toEqual({ teamKey: 'ENG' })
  })

  it('throws invalid-input when no team key is available', async () => {
    const { fetchImpl } = fakeFetch([])
    const p = new LinearWorkProvider({ apiKey: async () => 'key', fetchImpl })
    await expect(p.listStates()).rejects.toMatchObject({ category: 'invalid-input' })
  })
})

describe('LinearWorkProvider error mapping', () => {
  it('maps HTTP 401 to auth-expired', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(401, 'unauthorized')])
    await expect(provider(fetchImpl).get('ENG-1')).rejects.toMatchObject({
      category: 'auth-expired',
      retryable: false,
    })
  })

  it('maps HTTP 429 to rate-limit and honors Retry-After', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(429, 'slow down', { 'retry-after': '30' })])
    const error = await provider(fetchImpl)
      .get('ENG-1')
      .catch((e) => e as OrchestratorError)
    expect(error.category).toBe('rate-limit')
    expect(error.retryable).toBe(true)
    expect(error.options?.retryAfterMs).toBe(30_000)
  })

  it('maps HTTP 429 to rate-limit using X-RateLimit-Requests-Reset when Retry-After is absent', async () => {
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 60
    const { fetchImpl } = fakeFetch([
      textErrorResponse(429, 'slow down', {
        'x-ratelimit-requests-reset': String(resetEpochSeconds),
      }),
    ])
    const error = await provider(fetchImpl)
      .get('ENG-1')
      .catch((e) => e as OrchestratorError)
    expect(error.category).toBe('rate-limit')
    expect(error.options?.retryAfterMs).toBeGreaterThan(0)
    expect(error.options?.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('maps HTTP 5xx to provider-outage', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(503, 'down for maintenance')])
    await expect(provider(fetchImpl).get('ENG-1')).rejects.toMatchObject({
      category: 'provider-outage',
      retryable: true,
    })
  })

  it('maps a 200 response with a GraphQL errors array to invalid-input', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { errors: [{ message: 'Entity not found' }] }),
    ])
    await expect(provider(fetchImpl).get('ENG-1')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })

  it('maps a GraphQL error whose message indicates an authentication failure to auth-expired', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { errors: [{ message: 'Authentication required, not authorized' }] }),
    ])
    await expect(provider(fetchImpl).get('ENG-1')).rejects.toMatchObject({
      category: 'auth-expired',
    })
  })

  it('maps a GraphQL error with an AUTHENTICATION_ERROR extension code to auth-expired', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, {
        errors: [{ message: 'nope', extensions: { code: 'AUTHENTICATION_ERROR' } }],
      }),
    ])
    await expect(provider(fetchImpl).get('ENG-1')).rejects.toMatchObject({
      category: 'auth-expired',
    })
  })

  it('maps a fetch()-level rejection to a retryable network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const p = new LinearWorkProvider({ apiKey: async () => 'key', teamKey: 'ENG', fetchImpl })
    await expect(p.get('ENG-1')).rejects.toMatchObject({ category: 'network', retryable: true })
  })
})

describe('LinearWorkProvider body access', () => {
  it('getDescription() sends the IssueDescription query with the identifier', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: { issue: { id: 'internal-uuid-1', description: 'fresh description' } },
      }),
    ])
    const item = makeWorkItem({
      provider: 'linear',
      externalId: 'ENG-123',
      metadata: { linearId: 'internal-uuid-1' },
    })

    const description = await provider(fetchImpl).getDescription(item)

    expect(description).toBe('fresh description')
    const body = graphqlBody(calls[0])
    expect(body.query).toContain('query IssueDescription')
    expect(body.variables).toEqual({ id: 'ENG-123' })
  })

  it('getDescription() returns an empty string for a null description', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { data: { issue: { id: 'internal-uuid-1', description: null } } }),
    ])
    const item = makeWorkItem({ provider: 'linear', externalId: 'ENG-123' })
    expect(await provider(fetchImpl).getDescription(item)).toBe('')
  })

  it('getDescription() rejects when the issue does not exist', async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { data: { issue: null } })])
    const item = makeWorkItem({ provider: 'linear', externalId: 'ENG-404' })
    await expect(provider(fetchImpl).getDescription(item)).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })

  it('updateDescription() sends IssueUpdate with the internal Linear id', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        data: { issueUpdate: { success: true, issue: ISSUE_FIXTURE } },
      }),
    ])
    const item = makeWorkItem({
      provider: 'linear',
      externalId: 'ENG-123',
      metadata: { linearId: 'internal-uuid-1' },
    })

    await provider(fetchImpl).updateDescription(item, 'rewritten description')

    const body = graphqlBody(calls[0])
    expect(body.query).toContain('mutation IssueUpdate')
    expect(body.variables).toEqual({
      id: 'internal-uuid-1',
      input: { description: 'rewritten description' },
    })
  })

  it('updateDescription() rejects an item missing the internal Linear id', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const item = makeWorkItem({ provider: 'linear', externalId: 'ENG-123' })
    await expect(provider(fetchImpl).updateDescription(item, 'x')).rejects.toMatchObject({
      category: 'invalid-input',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('LinearWorkProvider.createItem', () => {
  function teamResponse() {
    return jsonResponse(200, {
      data: {
        team: {
          id: 'team-1',
          states: { nodes: [{ id: 'state-1', name: 'Todo', type: 'unstarted' }] },
          labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
        },
      },
    })
  }

  function issueCreateResponse() {
    return jsonResponse(200, { data: { issueCreate: { success: true, issue: ISSUE_FIXTURE } } })
  }

  it('sends issueCreate with teamId, title, description, and resolved labelIds, creating missing labels', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse(),
      jsonResponse(200, {
        data: {
          issueLabelCreate: { success: true, issueLabel: { id: 'label-infra', name: 'infra' } },
        },
      }),
      issueCreateResponse(),
    ])
    const item = await provider(fetchImpl).createItem({
      title: 'New task',
      description: 'Do it',
      labels: ['bug', 'infra'],
    })

    expect(graphqlBody(calls[0]).query).toContain('query Team')
    const labelCreate = graphqlBody(calls[1])
    expect(labelCreate.query).toContain('mutation IssueLabelCreate')
    expect(labelCreate.variables).toEqual({ input: { name: 'infra', teamId: 'team-1' } })
    const create = graphqlBody(calls[2])
    expect(create.query).toContain('mutation IssueCreate')
    expect(create.variables).toEqual({
      input: {
        teamId: 'team-1',
        title: 'New task',
        description: 'Do it',
        labelIds: ['label-bug', 'label-infra'],
      },
    })
    expect(item).toMatchObject({
      provider: 'linear',
      externalId: 'ENG-123',
      title: 'Fix the thing',
    })
  })

  it('resolves the target internal id into parentId for a child-of relateTo', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse(),
      jsonResponse(200, { data: { issue: { id: 'internal-uuid-2' } } }),
      issueCreateResponse(),
    ])
    await provider(fetchImpl).createItem({
      title: 'Child',
      relateTo: { kind: 'child-of', targetExternalId: 'ENG-999' },
    })

    const idLookup = graphqlBody(calls[1])
    expect(idLookup.query).toContain('query IssueId')
    expect(idLookup.variables).toEqual({ id: 'ENG-999' })
    expect(graphqlBody(calls[2]).variables).toEqual({
      input: { teamId: 'team-1', title: 'Child', parentId: 'internal-uuid-2' },
    })
    expect(calls).toHaveLength(3) // no issueRelationCreate for parenting
  })

  it('creates an issue relation after create for a blocks relateTo', async () => {
    const { fetchImpl, calls } = fakeFetch([
      teamResponse(),
      issueCreateResponse(),
      jsonResponse(200, { data: { issue: { id: 'internal-uuid-2' } } }),
      jsonResponse(200, { data: { issueRelationCreate: { success: true } } }),
    ])
    await provider(fetchImpl).createItem({
      title: 'Blocker',
      relateTo: { kind: 'blocks', targetExternalId: 'ENG-999' },
    })

    const relation = graphqlBody(calls[3])
    expect(relation.query).toContain('mutation IssueRelationCreate')
    expect(relation.variables).toEqual({
      input: { issueId: 'internal-uuid-1', relatedIssueId: 'internal-uuid-2', type: 'blocks' },
    })
  })

  it('requires a team key when neither container nor teamKey is set', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const p = new LinearWorkProvider({ apiKey: async () => 'k', fetchImpl })
    await expect(p.createItem({ title: 'x' })).rejects.toMatchObject({
      category: 'invalid-input',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('LinearWorkProvider.linkItems', () => {
  const item = makeWorkItem({
    provider: 'linear',
    externalId: 'ENG-123',
    metadata: { linearId: 'internal-uuid-1', teamKey: 'ENG' },
  })

  function idResponse() {
    return jsonResponse(200, { data: { issue: { id: 'internal-uuid-2' } } })
  }

  it('child-of sets parentId on the item itself via issueUpdate', async () => {
    const { fetchImpl, calls } = fakeFetch([
      idResponse(),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
    ])
    await provider(fetchImpl).linkItems(item, 'child-of', 'ENG-999')
    const update = graphqlBody(calls[1])
    expect(update.query).toContain('mutation IssueUpdate')
    expect(update.variables).toEqual({
      id: 'internal-uuid-1',
      input: { parentId: 'internal-uuid-2' },
    })
  })

  it('parent-of sets parentId on the target via issueUpdate', async () => {
    const { fetchImpl, calls } = fakeFetch([
      idResponse(),
      jsonResponse(200, { data: { issueUpdate: { success: true } } }),
    ])
    await provider(fetchImpl).linkItems(item, 'parent-of', 'ENG-999')
    expect(graphqlBody(calls[1]).variables).toEqual({
      id: 'internal-uuid-2',
      input: { parentId: 'internal-uuid-1' },
    })
  })

  const relationCases: readonly [
    Parameters<LinearWorkProvider['linkItems']>[1],
    { issueId: string; relatedIssueId: string; type: string },
  ][] = [
    ['blocks', { issueId: 'internal-uuid-1', relatedIssueId: 'internal-uuid-2', type: 'blocks' }],
    [
      'blocked-by',
      { issueId: 'internal-uuid-2', relatedIssueId: 'internal-uuid-1', type: 'blocks' },
    ],
    [
      'relates-to',
      { issueId: 'internal-uuid-1', relatedIssueId: 'internal-uuid-2', type: 'related' },
    ],
    [
      'duplicates',
      { issueId: 'internal-uuid-1', relatedIssueId: 'internal-uuid-2', type: 'duplicate' },
    ],
  ]

  for (const [kind, expectedInput] of relationCases) {
    it(`maps ${kind} onto issueRelationCreate type "${expectedInput.type}" with the right direction`, async () => {
      const { fetchImpl, calls } = fakeFetch([
        idResponse(),
        jsonResponse(200, { data: { issueRelationCreate: { success: true } } }),
      ])
      await provider(fetchImpl).linkItems(item, kind, 'ENG-999')
      const relation = graphqlBody(calls[1])
      expect(relation.query).toContain('mutation IssueRelationCreate')
      expect(relation.variables).toEqual({ input: expectedInput })
    })
  }

  it('rejects an item missing the Linear internal id without any request', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const bare = makeWorkItem({ provider: 'linear', externalId: 'ENG-123' })
    await expect(provider(fetchImpl).linkItems(bare, 'blocks', 'ENG-999')).rejects.toMatchObject({
      category: 'invalid-input',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown link target', async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { data: { issue: null } })])
    await expect(provider(fetchImpl).linkItems(item, 'blocks', 'ENG-404')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})
