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

describe('GitHubIssuesWorkProvider.createItem', () => {
  it('POSTs title, body, and labels to the issues endpoint and maps the created issue', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(201, {
        id: 1042,
        number: 42,
        node_id: 'n42',
        title: 'New task',
        body: 'Do it',
        state: 'open',
        labels: [{ name: 'bug' }],
        html_url: 'https://github.com/acme/widgets/issues/42',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const item = await provider.createItem({
      title: 'New task',
      description: 'Do it',
      labels: ['bug'],
    })

    expect(calls[0]?.url).toContain('/repos/acme/widgets/issues')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      title: 'New task',
      body: 'Do it',
      labels: ['bug'],
    })
    expect(item).toMatchObject({
      provider: 'github',
      externalId: '42',
      title: 'New task',
      labels: ['bug'],
    })
  })

  it('honors draft.container as the target repo', async () => {
    const backend = new FakeGitHubBackend('other/repo')
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.createItem({ title: 'Elsewhere', container: 'other/repo' })
    expect(item.repository?.locator).toBe('other/repo')
  })

  it('appends a reference line to the body for relateTo', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.createItem({
      title: 'Child task',
      description: 'Body',
      relateTo: { kind: 'child-of', targetExternalId: '7' },
    })
    expect(item.description).toBe('Body\n\nPart of #7')
  })

  it('uses the reference line alone as the body when there is no description', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.createItem({
      title: 'Related task',
      relateTo: { kind: 'relates-to', targetExternalId: '9' },
    })
    expect(item.description).toBe('Relates to #9')
  })

  it('propagates mapped errors', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(500, 'oops')])
    const provider = makeProvider(fetchImpl)
    await expect(provider.createItem({ title: 'x' })).rejects.toMatchObject({
      category: 'provider-outage',
    })
  })
})

describe('GitHubIssuesWorkProvider.linkItems', () => {
  it('parent-of adds the target as a sub-issue by database id', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const parent = backend.addIssue({ title: 'Parent' })
    const child = backend.addIssue({ title: 'Child' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(parent))

    await provider.linkItems(item, 'parent-of', String(child))
    expect(backend.subIssuesOf(parent)).toEqual([child])
  })

  it('child-of registers the item under the target parent', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const parent = backend.addIssue({ title: 'Parent' })
    const child = backend.addIssue({ title: 'Child' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(child))

    await provider.linkItems(item, 'child-of', String(parent))
    expect(backend.subIssuesOf(parent)).toEqual([child])
  })

  it('sends sub_issue_id in the sub-issues request body', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        id: 2007,
        number: 7,
        node_id: 'n7',
        title: 'Child',
        body: null,
        state: 'open',
        labels: [],
        html_url: 'u',
        updated_at: 'x',
      }),
      jsonResponse(201, {}),
    ])
    const provider = makeProvider(fetchImpl)
    const parent: WorkItem = {
      id: asId('github:acme/widgets#3'),
      provider: 'github',
      externalId: '3',
      title: 'Parent',
      state: 'open',
      labels: [],
      assignees: [],
      relationships: [],
      repository: { locator: 'acme/widgets' },
      metadata: {},
    }
    await provider.linkItems(parent, 'parent-of', '7')

    expect(calls[0]?.url).toContain('/repos/acme/widgets/issues/7')
    expect(calls[1]?.url).toContain('/repos/acme/widgets/issues/3/sub_issues')
    expect(calls[1]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ sub_issue_id: 2007 })
  })

  it('falls back to a body reference when sub-issues are unavailable', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    backend.subIssuesEnabled = false
    const parent = backend.addIssue({ title: 'Parent' })
    const child = backend.addIssue({ title: 'Child', body: 'Existing body' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(child))

    await provider.linkItems(item, 'child-of', String(parent))
    expect(backend.subIssuesOf(parent)).toEqual([])
    expect(backend.bodyOf(child)).toBe(`Existing body\n\nPart of #${parent}`)
  })

  it('models relates-to as a body reference line', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const a = backend.addIssue({ title: 'A', body: 'A body' })
    const b = backend.addIssue({ title: 'B' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(a))

    await provider.linkItems(item, 'relates-to', String(b))
    expect(backend.bodyOf(a)).toBe(`A body\n\nRelates to #${b}`)
  })

  it('models blocks as a body reference line', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const a = backend.addIssue({ title: 'A' })
    const b = backend.addIssue({ title: 'B' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(a))

    await provider.linkItems(item, 'blocks', String(b))
    expect(backend.bodyOf(a)).toBe(`Blocks #${b}`)
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

describe('GitHubIssuesWorkProvider body access', () => {
  it('getDescription() fetches the fresh issue body, ignoring the cached item', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Doc me', body: 'original body' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    await provider.updateDescription(item, 'updated body')

    // `item` still carries the stale description; the fetch must be fresh.
    expect(item.description).toBe('original body')
    expect(await provider.getDescription(item)).toBe('updated body')
  })

  it('getDescription() returns an empty string for a null body', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'No body' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    expect(await provider.getDescription(item)).toBe('')
  })

  it('updateDescription() PATCHes the issue with the new body', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        number: 8,
        node_id: 'n8',
        title: 'x',
        body: 'new body',
        state: 'open',
        labels: [],
        html_url: 'u',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: asId('github:acme/widgets#8'),
      provider: 'github',
      externalId: '8',
      title: 'x',
      state: 'open',
      labels: [],
      assignees: [],
      relationships: [],
      repository: { locator: 'acme/widgets' },
      metadata: {},
    }

    await provider.updateDescription(item, 'new body')

    expect(calls[0]?.url).toContain('/repos/acme/widgets/issues/8')
    expect(calls[0]?.init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ body: 'new body' })
  })

  it('updateDescription() surfaces mapped HTTP errors', async () => {
    const backend = new FakeGitHubBackend('acme/widgets')
    const number = backend.addIssue({ title: 'Doc me' })
    const provider = makeProvider(backend.fetchImpl)
    const item = await provider.get(String(number))

    const failing = makeProvider(fakeFetch([textErrorResponse(403, 'forbidden')]).fetchImpl)
    await expect(failing.updateDescription(item, 'x')).rejects.toMatchObject({
      category: 'invalid-input',
    })
  })
})
