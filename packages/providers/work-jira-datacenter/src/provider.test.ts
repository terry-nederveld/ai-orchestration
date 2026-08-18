import { OrchestratorError, type WorkItem } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { JiraDataCenterWorkProvider } from './provider.js'
import { fakeFetch, jsonResponse, textErrorResponse } from './test-helpers.js'

function makeProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<{ projectKey: string; claimLabel: string }> = {},
): JiraDataCenterWorkProvider {
  return new JiraDataCenterWorkProvider({
    baseUrl: 'https://jira.company.com',
    auth: async () => ({ pat: 'pat-token-abc' }),
    fetchImpl,
    ...overrides,
  })
}

function issueFixture(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      labels: [],
      ...overrides,
    },
  }
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'jira-datacenter:PROJ-1' as WorkItem['id'],
    provider: 'jira-datacenter',
    externalId: 'PROJ-1',
    title: 'x',
    state: 'To Do',
    labels: [],
    assignees: [],
    relationships: [],
    metadata: {},
    ...overrides,
  }
}

describe('JiraDataCenterWorkProvider', () => {
  it('sends Bearer auth built from a PAT', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { issues: [], startAt: 0, maxResults: 50, total: 0 }),
    ])
    const provider = makeProvider(fetchImpl)
    await provider.discover({})
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer pat-token-abc' })
  })

  it('sends Basic auth built from username:password', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { issues: [], startAt: 0, maxResults: 50, total: 0 }),
    ])
    const provider = new JiraDataCenterWorkProvider({
      baseUrl: 'https://jira.company.com',
      auth: async () => ({ username: 'jdoe', password: 'secret' }),
      fetchImpl,
    })
    await provider.discover({})
    const expected = `Basic ${Buffer.from('jdoe:secret').toString('base64')}`
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: expected })
  })

  it('discover() paginates via startAt/maxResults offsets until total is reached', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        issues: [issueFixture('PROJ-1'), issueFixture('PROJ-2')],
        startAt: 0,
        maxResults: 2,
        total: 3,
      }),
      jsonResponse(200, {
        issues: [issueFixture('PROJ-3')],
        startAt: 2,
        maxResults: 2,
        total: 3,
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ container: 'PROJ' })

    expect(items.map((i) => i.externalId)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('/rest/api/2/search')
    expect(calls[0]?.url).toContain('startAt=0')
    expect(calls[1]?.url).toContain('startAt=2')
    for (const call of calls) expect(call.url).not.toContain('/search/jql')
  })

  it('discover() stops once the requested limit is satisfied', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        issues: [issueFixture('PROJ-1'), issueFixture('PROJ-2')],
        startAt: 0,
        maxResults: 2,
        total: 10,
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ limit: 2 })
    expect(items).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('discover() requests the documented field set', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { issues: [], startAt: 0, maxResults: 50, total: 0 }),
    ])
    const provider = makeProvider(fetchImpl)
    await provider.discover({})
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('fields')).toBe(
      'summary,description,status,issuetype,priority,labels,assignee,updated',
    )
  })

  it('get() fetches a single issue by key', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, issueFixture('PROJ-9'))])
    const provider = makeProvider(fetchImpl)
    const item = await provider.get('PROJ-9')
    expect(item.externalId).toBe('PROJ-9')
    expect(calls[0]?.url).toContain('/rest/api/2/issue/PROJ-9')
  })

  it('claim() adds the claim label and posts a plain-string marker comment', async () => {
    const { fetchImpl, calls } = fakeFetch([
      new Response(null, { status: 204 }),
      new Response(null, { status: 201 }),
    ])
    const provider = makeProvider(fetchImpl)
    const result = await provider.claim(makeItem(), { claimant: 'agent-a', runId: 'run-1' })
    expect(result.outcome).toBe('claimed')
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      update: { labels: [{ add: 'overture-claimed' }] },
    })
    expect(calls[1]?.url).toContain('/comment')
    const commentBody = JSON.parse(String(calls[1]?.init.body)) as { body: unknown }
    expect(typeof commentBody.body).toBe('string')
    expect(commentBody.body).toContain('Claimed by agent-a')
  })

  it('claim() reports already-claimed without any HTTP call when the label is present', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const provider = makeProvider(fetchImpl)
    const result = await provider.claim(makeItem({ labels: ['overture-claimed'] }), {
      claimant: 'agent-a',
      runId: 'run-1',
    })
    expect(result.outcome).toBe('already-claimed')
    expect(calls).toHaveLength(0)
  })

  it('release() removes the claim label', async () => {
    const { fetchImpl, calls } = fakeFetch([new Response(null, { status: 204 })])
    const provider = makeProvider(fetchImpl)
    await provider.release(makeItem({ labels: ['overture-claimed'] }), {
      claimant: 'agent-a',
      runId: 'run-1',
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      update: { labels: [{ remove: 'overture-claimed' }] },
    })
  })

  it('comment() posts the body as a plain string, never wrapped in ADF', async () => {
    const { fetchImpl, calls } = fakeFetch([new Response(null, { status: 201 })])
    const provider = makeProvider(fetchImpl)
    await provider.comment(makeItem(), { body: 'hello there' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ body: 'hello there' })
  })

  it('transition() resolves the target state case-insensitively and posts the transition id', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        transitions: [
          { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
          { id: '21', name: 'Done', to: { name: 'Done' } },
        ],
      }),
      new Response(null, { status: 204 }),
    ])
    const provider = makeProvider(fetchImpl)
    await provider.transition(makeItem(), { targetState: 'in progress' })
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ transition: { id: '11' } })
  })

  it('transition() throws invalid-input listing available transitions for an unknown target', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { transitions: [{ id: '11', name: 'Start Progress' }] }),
    ])
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.transition(makeItem(), { targetState: 'Nonexistent' }),
    ).rejects.toMatchObject({
      category: 'invalid-input',
      message: expect.stringContaining('Start Progress'),
    })
  })

  it('transition() sends a plain-string comment body when a transition comment is given', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { transitions: [{ id: '11', name: 'Done', to: { name: 'Done' } }] }),
      new Response(null, { status: 204 }),
    ])
    const provider = makeProvider(fetchImpl)
    await provider.transition(makeItem(), { targetState: 'Done', comment: 'wrapping up' })
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      transition: { id: '11' },
      update: { comment: [{ add: { body: 'wrapping up' } }] },
    })
  })

  it('listStates() maps project statuses and dedupes by status id', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, [
        {
          name: 'Bug',
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '3', name: 'Done', statusCategory: { key: 'done' } },
          ],
        },
        {
          name: 'Story',
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          ],
        },
      ]),
    ])
    const provider = makeProvider(fetchImpl, { projectKey: 'PROJ' })
    const states = await provider.listStates()
    expect(calls[0]?.url).toContain('/rest/api/2/project/PROJ/statuses')
    expect(states).toEqual([
      { id: '1', name: 'To Do', category: 'todo' },
      { id: '3', name: 'Done', category: 'done' },
      { id: '2', name: 'In Progress', category: 'in-progress' },
    ])
  })

  it('listStates() falls back to the global /status endpoint without a project key', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }]),
    ])
    const provider = makeProvider(fetchImpl)
    const states = await provider.listStates()
    expect(calls[0]?.url).toContain('/rest/api/2/status')
    expect(states).toEqual([{ id: '1', name: 'To Do', category: 'todo' }])
  })

  it('maps a 429 response to rate-limit with retryAfterMs', async () => {
    const { fetchImpl } = fakeFetch([
      textErrorResponse(429, JSON.stringify({ errorMessages: ['slow down'] }), {
        'retry-after': '2',
        'content-type': 'application/json',
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const error = (await provider.discover({}).catch((e) => e)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.category).toBe('rate-limit')
    expect(error.options?.retryAfterMs).toBe(2000)
  })

  it('maps a 401 response to auth-expired', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(401, 'unauthorized')])
    const provider = makeProvider(fetchImpl)
    const error = (await provider.discover({}).catch((e) => e)) as OrchestratorError
    expect(error.category).toBe('auth-expired')
  })

  it('maps a 409 response to conflict', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(409, 'conflict')])
    const provider = makeProvider(fetchImpl)
    const error = (await provider.discover({}).catch((e) => e)) as OrchestratorError
    expect(error.category).toBe('conflict')
  })

  it('maps a 500 response to provider-outage', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(500, 'boom')])
    const provider = makeProvider(fetchImpl)
    const error = (await provider.discover({}).catch((e) => e)) as OrchestratorError
    expect(error.category).toBe('provider-outage')
  })

  it('maps a fetch-level rejection to network', async () => {
    const provider = makeProvider((async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch)
    const error = (await provider.discover({}).catch((e) => e)) as OrchestratorError
    expect(error.category).toBe('network')
  })
})

describe('JiraDataCenterWorkProvider body access', () => {
  const item: WorkItem = {
    id: 'jira-datacenter:PROJ-5' as WorkItem['id'],
    provider: 'jira-datacenter',
    externalId: 'PROJ-5',
    title: 'x',
    state: 'To Do',
    labels: [],
    assignees: [],
    relationships: [],
    metadata: {},
  }

  it('getDescription() fetches only the description field as a plain string', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { key: 'PROJ-5', fields: { description: 'plain wiki text' } }),
    ])
    const provider = makeProvider(fetchImpl)

    expect(await provider.getDescription(item)).toBe('plain wiki text')
    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/rest/api/2/issue/PROJ-5')
    expect(url.searchParams.get('fields')).toBe('description')
  })

  it('getDescription() returns an empty string for a null description', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { key: 'PROJ-5', fields: { description: null } }),
    ])
    const provider = makeProvider(fetchImpl)
    expect(await provider.getDescription(item)).toBe('')
  })

  it('updateDescription() PUTs the body as a plain string', async () => {
    const { fetchImpl, calls } = fakeFetch([new Response(null, { status: 204 })])
    const provider = makeProvider(fetchImpl)

    await provider.updateDescription(item, 'new plain body')

    expect(calls[0]?.url).toContain('/rest/api/2/issue/PROJ-5')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      fields: { description: 'new plain body' },
    })
  })

  it('updateDescription() surfaces mapped HTTP errors', async () => {
    const { fetchImpl } = fakeFetch([textErrorResponse(401, 'unauthorized')])
    const provider = makeProvider(fetchImpl)
    await expect(provider.updateDescription(item, 'x')).rejects.toMatchObject({
      category: 'auth-expired',
    })
  })
})
