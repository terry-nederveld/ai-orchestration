import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDaemonInfo } from '@overture/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, connect, DaemonClient, DaemonUnavailableError } from './client.js'
import { main } from './main.js'
import { formatDate, renderTable, shortId } from './output.js'

describe('connect', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'overture-cli-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('throws DaemonUnavailableError with no daemon info', async () => {
    await expect(connect(dir)).rejects.toThrow(DaemonUnavailableError)
  })

  it('throws when the recorded pid is dead', async () => {
    await writeDaemonInfo(dir, { host: '127.0.0.1', port: 1, token: 't', pid: 999999999 })
    await expect(connect(dir)).rejects.toThrow(DaemonUnavailableError)
  })

  it('returns a connection for a live pid', async () => {
    await writeDaemonInfo(dir, { host: '127.0.0.1', port: 4242, token: 'tok', pid: process.pid })
    const connection = await connect(dir)
    expect(connection.baseUrl).toBe('http://127.0.0.1:4242')
    expect(connection.token).toBe('tok')
  })
})

describe('DaemonClient', () => {
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'secret' }

  it('sends the bearer token and parses JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new DaemonClient(connection, (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch)
    const result = await client.get<{ ok: boolean }>('/api/status')
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('http://127.0.0.1:9/api/status')
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret')
  })

  it('maps API errors with server-provided messages', async () => {
    const client = new DaemonClient(
      connection,
      (async () =>
        new Response(JSON.stringify({ error: 'run not found' }), { status: 404 })) as typeof fetch,
    )
    await expect(client.get('/api/runs/x')).rejects.toThrow(ApiError)
    await expect(client.get('/api/runs/x')).rejects.toThrow('run not found')
  })

  it('posts JSON bodies', async () => {
    let body: unknown
    const client = new DaemonClient(connection, (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 201 })
    }) as typeof fetch)
    await client.post('/api/runs', { workItem: 'fake:1' })
    expect(body).toEqual({ workItem: 'fake:1' })
  })
})

describe('phase 2 commands', () => {
  let dir: string
  let server: Server
  let previousXdg: string | undefined
  let logs: string[]
  const requests: Array<{
    method: string
    url: string
    body: unknown
    auth: string | undefined
  }> = []

  function respond(method: string, url: string): { status: number; body: unknown } {
    const path = url.split('?')[0]
    if (method === 'GET' && path === '/api/waits') {
      return {
        status: 200,
        body: [
          {
            id: 'wait-1',
            runId: 'run-1',
            nodeId: 'ask-user',
            kind: 'human-input',
            createdAt: '2026-08-18T09:00:00.000Z',
            request: { type: 'text', prompt: 'Pick a color' },
          },
        ],
      }
    }
    if (method === 'POST' && path === '/api/waits/wait-1/respond') {
      return { status: 200, body: { accepted: true } }
    }
    if (method === 'GET' && path === '/api/definitions') {
      return {
        status: 200,
        body: [{ kind: 'workflow', name: 'greeter', lifecycle: 'draft', latestVersion: 2 }],
      }
    }
    if (method === 'POST' && path === '/api/definitions/workflow/greeter/lifecycle') {
      return {
        status: 200,
        body: { kind: 'workflow', name: 'greeter', lifecycle: 'enabled', latestVersion: 2 },
      }
    }
    if (method === 'GET' && path === '/api/graph-runs/run-1') {
      return {
        status: 200,
        body: {
          run: { id: 'run-1', state: 'waiting_for_human' },
          state: { runId: 'run-1', specRevision: 3, activeNodeIds: ['ask-user'] },
          openWaits: [],
        },
      }
    }
    return { status: 404, body: { error: `no route for ${method} ${path}` } }
  }

  beforeEach(async () => {
    requests.length = 0
    logs = []
    dir = await mkdtemp(join(tmpdir(), 'overture-cli-'))
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: raw ? JSON.parse(raw) : undefined,
          auth: request.headers.authorization,
        })
        const payload = respond(request.method ?? '', request.url ?? '')
        response.writeHead(payload.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload.body))
      })
    })
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const { port } = server.address() as AddressInfo
    previousXdg = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = dir
    await writeDaemonInfo(join(dir, 'overture'), {
      host: '127.0.0.1',
      port,
      token: 'tok',
      pid: process.pid,
    })
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line))
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (previousXdg === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousXdg
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
    })
    await rm(dir, { recursive: true, force: true })
  })

  it('waits list renders open waits', async () => {
    const code = await main(['waits', 'list'])
    expect(code).toBe(0)
    const output = logs.join('\n')
    expect(output).toContain('wait-1')
    expect(output).toContain('Pick a color')
    expect(requests[0]?.auth).toBe('Bearer tok')
  })

  it('waits respond posts a typed value', async () => {
    const code = await main(['waits', 'respond', 'wait-1', '--value', 'true', '--by', 'terry'])
    expect(code).toBe(0)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url).toBe('/api/waits/wait-1/respond')
    expect(requests[0]?.body).toEqual({ value: true, respondedBy: 'terry' })
  })

  it('definitions list renders the definition table', async () => {
    const code = await main(['definitions', 'list'])
    expect(code).toBe(0)
    const output = logs.join('\n')
    expect(output).toContain('greeter')
    expect(output).toContain('draft')
  })

  it('definitions enable posts the lifecycle change', async () => {
    const code = await main(['definitions', 'enable', 'workflow', 'greeter'])
    expect(code).toBe(0)
    expect(requests[0]?.url).toBe('/api/definitions/workflow/greeter/lifecycle')
    expect(requests[0]?.body).toEqual({ lifecycle: 'enabled' })
  })

  it('graph-run show prints the run view', async () => {
    const code = await main(['graph-run', 'show', 'run-1'])
    expect(code).toBe(0)
    const output = logs.join('\n')
    expect(output).toContain('"specRevision": 3')
    expect(output).toContain('"id": "run-1"')
  })
})

describe('output helpers', () => {
  it('renders aligned tables', () => {
    const table = renderTable(
      [
        { a: 'one', b: 'x' },
        { a: 'longer', b: 'y' },
      ],
      [
        { header: 'A', value: (row) => row.a },
        { header: 'B', value: (row) => row.b },
      ],
    )
    const lines = table.split('\n')
    expect(lines[0]).toBe('A       B')
    expect(lines[2]).toBe('one     x')
    expect(lines[3]).toBe('longer  y')
  })

  it('formats dates and handles junk', () => {
    expect(formatDate('2026-08-14T12:30:00.000Z')).toBe('2026-08-14 12:30:00')
    expect(formatDate('not a date')).toBe('')
    expect(formatDate(42)).toBe('')
  })

  it('shortens long ids', () => {
    expect(shortId('short')).toBe('short')
    expect(shortId('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…`)
  })
})
