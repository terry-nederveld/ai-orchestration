import { asId, type WorkItem } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { GitHubIssuesWorkProvider } from './issues-provider.js'
import {
  FakeGitHubBackend,
  fakeFetch,
  jsonResponse,
  routedFetch,
  textErrorResponse,
} from './test-helpers.js'

function makeProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof GitHubIssuesWorkProvider>[0]> = {},
) {
  return new GitHubIssuesWorkProvider({
    token: async () => 'ghp_test',
    repo: 'acme/widgets',
    fetchImpl,
    ...overrides,
  })
}

describe('GitHubIssuesWorkProvider.discover', () => {
  it('maps a REST issue onto the canonical WorkItem shape', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, [
        {
          number: 42,
          node_id: 'node_42',
          title: 'Fix the thing',
          body: 'Details here',
          state: 'open',
          labels: [{ name: 'bug' }, 'urgent'],
          assignees: [{ login: 'alice', id: 1 }],
          html_url: 'https://github.com/acme/widgets/issues/42',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl, { defaultBranch: 'main' })
    const items = await provider.discover({})

    expect(items).toEqual([
      {
        id: asId('github:acme/widgets#42'),
        provider: 'github',
        externalId: '42',
        title: 'Fix the thing',
        description: 'Details here',
        state: 'open',
        labels: ['bug', 'urgent'],
        assignees: [{ id: 'alice', displayName: 'alice' }],
        relationships: [],
        repository: { locator: 'acme/widgets', defaultBranch: 'main' },
        metadata: { number: 42, nodeId: 'node_42' },
        url: 'https://github.com/acme/widgets/issues/42',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])

    expect(calls[0]?.url).toContain('/repos/acme/widgets/issues?state=open')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer ghp_test')
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(headers.get('accept')).toBe('application/vnd.github+json')
  })

  it('skips pull requests returned in the issues list', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, [
        {
          number: 1,
          node_id: 'n1',
          title: 'Real issue',
          body: null,
          state: 'open',
          labels: [],
          html_url: 'u',
          updated_at: 'x',
        },
        {
          number: 2,
          node_id: 'n2',
          title: 'A pull request',
          body: null,
          state: 'open',
          labels: [],
          html_url: 'u',
          updated_at: 'x',
          pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2' },
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({})
    expect(items.map((i) => i.externalId)).toEqual(['1'])
  })

  it('follows Link-header pagination up to the requested limit', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    for (let i = 0; i < 5; i++) backend.addIssue({ title: `Issue ${i}` })

    // Force small pages so pagination actually kicks in, since the fake
    // backend otherwise returns all 5 issues in a single response.
    const fetchImpl = routedFetch((url, init) => {
      const u = new URL(url)
      u.searchParams.set('per_page', '2')
      return backend.fetchImpl(u.toString(), init)
    })
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ limit: 3 })
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.externalId)).toEqual(['1', '2', '3'])
  })

  it('applies labelsExclude client-side', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, [
        {
          number: 1,
          node_id: 'n1',
          title: 'Keep',
          body: null,
          state: 'open',
          labels: [{ name: 'bug' }],
          html_url: 'u',
          updated_at: 'x',
        },
        {
          number: 2,
          node_id: 'n2',
          title: 'Drop',
          body: null,
          state: 'open',
          labels: [{ name: 'wontfix' }],
          html_url: 'u',
          updated_at: 'x',
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ labelsExclude: ['wontfix'] })
    expect(items.map((i) => i.externalId)).toEqual(['1'])
  })

  it('requests state=all and filters client-side when multiple states are requested', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, [
        {
          number: 1,
          node_id: 'n1',
          title: 'Open one',
          body: null,
          state: 'open',
          labels: [],
          html_url: 'u',
          updated_at: 'x',
        },
        {
          number: 2,
          node_id: 'n2',
          title: 'Closed one',
          body: null,
          state: 'closed',
          labels: [],
          html_url: 'u',
          updated_at: 'x',
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ states: ['open', 'closed'] })
    expect(items).toHaveLength(2)
    expect(calls[0]?.url).toContain('state=all')
  })

  it('reports custom workflow states from configured stateLabels', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, [
        {
          number: 1,
          node_id: 'n1',
          title: 'In review',
          body: null,
          state: 'open',
          labels: [{ name: 'status:review' }],
          html_url: 'u',
          updated_at: 'x',
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl, { stateLabels: { review: 'status:review' } })
    const items = await provider.discover({})
    expect(items[0]?.state).toBe('review')
  })
})

describe('GitHubIssuesWorkProvider.claim / release', () => {
  it('claims an unclaimed issue by adding the label, assigning the viewer, and posting a marker comment', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Claim me' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    const result = await provider.claim(item, { claimant: 'agent-a', runId: 'run-1' })
    expect(result.outcome).toBe('claimed')
    expect(backend.labelsOf(number)).toContain('overture:claimed')
  })

  it('is idempotent for the same claimant and rejects a competing claimant', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Claim me' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    const claimA = { claimant: 'agent-a', runId: 'run-1' }
    expect((await provider.claim(item, claimA)).outcome).toBe('claimed')
    expect((await provider.claim(item, claimA)).outcome).toBe('claimed')

    const claimB = { claimant: 'agent-b', runId: 'run-2' }
    const result = await provider.claim(item, claimB)
    expect(result.outcome).toBe('already-claimed')
    expect(result.detail).toContain('agent-a')
  })

  it('release() removes the claim label and allows a different claimant to claim', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Claim me' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    const claimA = { claimant: 'agent-a', runId: 'run-1' }
    await provider.claim(item, claimA)
    await provider.release(item, claimA)
    expect(backend.labelsOf(number)).not.toContain('overture:claimed')

    const claimB = { claimant: 'agent-b', runId: 'run-2' }
    expect((await provider.claim(item, claimB)).outcome).toBe('claimed')
  })

  it('uses a custom claim label when configured', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Claim me' })
    const provider = makeProvider(backend.fetchImpl, { claimLabel: 'in-progress:overture' })
    const item = await provider.get(String(number))

    await provider.claim(item, { claimant: 'agent-a', runId: 'run-1' })
    expect(backend.labelsOf(number)).toContain('in-progress:overture')
  })
})

describe('GitHubIssuesWorkProvider.transition', () => {
  it('closes an issue with state_reason completed', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        number: 1,
        node_id: 'n1',
        title: 'x',
        body: null,
        state: 'closed',
        labels: [],
        html_url: 'u',
        updated_at: 'x',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: asId('github:acme/widgets#1'),
      provider: 'github',
      externalId: '1',
      title: 'x',
      state: 'open',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await provider.transition(item, { targetState: 'closed' })
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('applies and swaps configured stateLabels, removing other configured state labels', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'x', labels: ['status:todo'] })
    const provider = makeProvider(backend.fetchImpl, {
      stateLabels: { todo: 'status:todo', review: 'status:review', done: 'status:done' },
    })
    const item = await provider.get(String(number))

    await provider.transition(item, { targetState: 'review' })
    expect(backend.labelsOf(number)).toEqual(['status:review'])
  })

  it('rejects an unknown target state that is not open/closed/a configured stateLabel', async () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch)
    const item: WorkItem = {
      id: asId('github:acme/widgets#1'),
      provider: 'github',
      externalId: '1',
      title: 'x',
      state: 'open',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await expect(provider.transition(item, { targetState: 'bogus' })).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})

describe('GitHubIssuesWorkProvider error mapping', () => {
  const item: WorkItem = {
    id: asId('github:acme/widgets#1'),
    provider: 'github',
    externalId: '1',
    title: 'x',
    state: 'open',
    labels: [],
    assignees: [],
    relationships: [],
    metadata: {},
  }

  it('maps 403 with x-ratelimit-remaining: 0 to a retryable rate-limit error', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(403, '{"message":"API rate limit exceeded"}', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      }),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.get('1')).rejects.toMatchObject({
      category: 'rate-limit',
      retryable: true,
    })
  })

  it('maps 429 to a retryable rate-limit error carrying retryAfterMs', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(429, '{"message":"secondary rate limit"}', { 'retry-after': '5' }),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(provider.get('1')).rejects.toMatchObject({
      category: 'rate-limit',
      retryable: true,
      options: { retryAfterMs: 5000 },
    })
  })

  it('maps 401 to a non-retryable auth-expired error', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(401, '{"message":"Bad credentials"}')])
    const provider = makeProvider(fetchImpl)
    await expect(provider.get('1')).rejects.toMatchObject({
      category: 'auth-expired',
      retryable: false,
    })
  })

  it('maps 5xx to a retryable provider-outage error', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(502, 'bad gateway')])
    const provider = makeProvider(fetchImpl)
    await expect(provider.get('1')).rejects.toMatchObject({
      category: 'provider-outage',
      retryable: true,
    })
  })

  it('maps a network failure to a retryable network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const provider = makeProvider(fetchImpl)
    await expect(provider.get('1')).rejects.toMatchObject({ category: 'network', retryable: true })
  })

  it('comment() propagates mapped errors', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(500, 'oops')])
    const provider = makeProvider(fetchImpl)
    await expect(provider.comment(item, { body: 'hi' })).rejects.toMatchObject({
      category: 'provider-outage',
    })
  })
})

describe('GitHubIssuesWorkProvider.detect', () => {
  it('reports unauthenticated when no token resolves', async () => {
    const provider = new GitHubIssuesWorkProvider({
      token: async () => undefined,
      repo: 'acme/widgets',
      fetchImpl: (async () => new Response()) as typeof fetch,
    })
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: false, authenticated: false })
  })

  it('reports available when /user succeeds', async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { login: 'octocat', id: 1 })])
    const provider = makeProvider(fetchImpl)
    const availability = await provider.detect()
    expect(availability).toMatchObject({ available: true, authenticated: true })
  })
})

describe('GitHubIssuesWorkProvider.listStates', () => {
  it('returns open/closed plus configured stateLabels keys', async () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch, {
      stateLabels: { review: 'status:review' },
    })
    const states = await provider.listStates()
    expect(states.map((s) => s.id)).toEqual(['open', 'closed', 'review'])
  })
})
