import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDaemonInfo } from '@overture/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError, connect, DaemonClient, DaemonUnavailableError } from './client.js'
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
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer secret')
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
