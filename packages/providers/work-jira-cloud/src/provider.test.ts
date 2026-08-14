import { OrchestratorError, type WorkItem } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { JiraCloudWorkProvider } from './provider.js'
import { fakeFetch, jsonResponse, textErrorResponse } from './test-helpers.js'

function makeProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<{ projectKey: string; claimLabel: string }> = {},
): JiraCloudWorkProvider {
  return new JiraCloudWorkProvider({
    site: 'mycompany',
    auth: async () => ({ email: 'bot@mycompany.com', apiToken: 'token-abc' }),
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

describe('JiraCloudWorkProvider', () => {
  it('sends Basic auth built from email:apiToken', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { issues: [], isLast: true })])
    const provider = makeProvider(fetchImpl)
    await provider.discover({})
    const expected = `Basic ${Buffer.from('bot@mycompany.com:token-abc').toString('base64')}`
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: expected })
  })

  it('sends Bearer auth when given an OAuth token', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { issues: [], isLast: true })])
    const provider = new JiraCloudWorkProvider({
      site: 'mycompany',
      auth: async () => ({ bearer: 'oauth-token' }),
      fetchImpl,
    })
    await provider.discover({})
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer oauth-token' })
  })

  it('discover() paginates via nextPageToken until isLast or limit is reached', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        issues: [issueFixture('PROJ-1'), issueFixture('PROJ-2')],
        nextPageToken: 'page-2',
        isLast: false,
      }),
      jsonResponse(200, { issues: [issueFixture('PROJ-3')], isLast: true }),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ container: 'PROJ' })

    expect(items.map((i) => i.externalId)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('/rest/api/3/search/jql')
    expect(calls[1]?.url).toContain('nextPageToken=page-2')
    for (const call of calls) expect(call.url).not.toContain('/rest/api/2/search')
  })

  it('discover() stops once the requested limit is satisfied', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, {
        issues: [issueFixture('PROJ-1'), issueFixture('PROJ-2')],
        nextPageToken: 'page-2',
        isLast: false,
      }),
    ])
    const provider = makeProvider(fetchImpl)
    const items = await provider.discover({ limit: 2 })
    expect(items).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('discover() requests the documented field set', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { issues: [], isLast: true })])
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
    expect(calls[0]?.url).toContain('/rest/api/3/issue/PROJ-9')
  })

  it('claim() adds the claim label and posts a marker comment', async () => {
    const { fetchImpl, calls } = fakeFetch([
      new Response(null, { status: 204 }),
      new Response(null, { status: 201 }),
    ])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    const result = await provider.claim(item, { claimant: 'agent-a', runId: 'run-1' })
    expect(result.outcome).toBe('claimed')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      update: { labels: [{ add: 'overture-claimed' }] },
    })
    expect(calls[1]?.init.method).toBe('POST')
    expect(calls[1]?.url).toContain('/comment')
  })

  it('claim() reports already-claimed without any HTTP call when the label is present', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: ['overture-claimed'],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    const result = await provider.claim(item, { claimant: 'agent-a', runId: 'run-1' })
    expect(result.outcome).toBe('already-claimed')
    expect(calls).toHaveLength(0)
  })

  it('release() removes the claim label', async () => {
    const { fetchImpl, calls } = fakeFetch([new Response(null, { status: 204 })])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: ['overture-claimed'],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await provider.release(item, { claimant: 'agent-a', runId: 'run-1' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      update: { labels: [{ remove: 'overture-claimed' }] },
    })
  })

  it('comment() wraps the plain-text body as minimal ADF', async () => {
    const { fetchImpl, calls } = fakeFetch([new Response(null, { status: 201 })])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await provider.comment(item, { body: 'hello there' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello there' }] }],
      },
    })
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
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await provider.transition(item, { targetState: 'in progress' })
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ transition: { id: '11' } })
  })

  it('transition() throws invalid-input listing available transitions for an unknown target', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, { transitions: [{ id: '11', name: 'Start Progress' }] }),
    ])
    const provider = makeProvider(fetchImpl)
    const item: WorkItem = {
      id: 'jira-cloud:PROJ-1' as WorkItem['id'],
      provider: 'jira-cloud',
      externalId: 'PROJ-1',
      title: 'x',
      state: 'To Do',
      labels: [],
      assignees: [],
      relationships: [],
      metadata: {},
    }
    await expect(provider.transition(item, { targetState: 'Nonexistent' })).rejects.toMatchObject({
      category: 'invalid-input',
      message: expect.stringContaining('Start Progress'),
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
    expect(calls[0]?.url).toContain('/rest/api/3/project/PROJ/statuses')
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
    expect(calls[0]?.url).toContain('/rest/api/3/status')
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
    const error = await provider.discover({}).catch((e) => e as OrchestratorError)
    expect(error).toBeInstanceOf(OrchestratorError)
    expect((error as OrchestratorError).category).toBe('rate-limit')
    expect((error as OrchestratorError).options?.retryAfterMs).toBe(2000)
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
