import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entry, type FakeRuntime, installFetchMock, statusPayload } from '../test/mockRuntimes'
import { ConnectionProvider } from './connection'
import { clearFederatedCache, primeFederatedCache, useFederatedQuery } from './federation'
import type { Run } from './types'
import { useNeedsYouCount } from './useNeedsYou'

function makeRun(id: string, updatedAt: string): Run {
  return {
    id,
    workItemId: `gh:ISSUE-${id}`,
    workflowName: 'mini',
    state: 'RUNNING',
    sessionIds: [],
    createdAt: updatedAt,
    updatedAt,
    history: [],
  }
}

function makeWait(id: string, runId: string): Record<string, unknown> {
  return {
    id,
    runId,
    nodeId: 'ask-user',
    kind: 'human-input',
    parameters: {},
    request: { type: 'text', prompt: 'Which color?', surface: 'app' },
    status: 'open',
    createdAt: new Date().toISOString(),
  }
}

function wrapperFor(entries: Parameters<typeof ConnectionProvider>[0]['initialEntries']) {
  return function Wrapper({ children }: { readonly children: ReactNode }): JSX.Element {
    return (
      <ConnectionProvider initialEntries={entries} pollMs={60_000}>
        {children}
      </ConnectionProvider>
    )
  }
}

beforeEach(() => {
  clearFederatedCache()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useFederatedQuery', () => {
  it('aggregates records across two connections, degrading the unreachable one to stale cache', async () => {
    const laptopRun = makeRun('run-a', '2026-08-18T10:00:00Z')
    const officeRun = makeRun('run-b', '2026-08-18T09:00:00Z')
    const runtimes: FakeRuntime[] = [
      {
        port: 5001,
        routes: {
          '/api/status': () => statusPayload(),
          '/api/runs': () => [laptopRun],
        },
      },
      { port: 5002, routes: {}, fail: true },
    ]
    installFetchMock(runtimes)
    // The office runtime answered in a previous session; its last-known data
    // is still on hand.
    primeFederatedCache('office', 'runs', [officeRun], '2026-08-18T09:30:00Z')

    const { result } = renderHook(
      () => useFederatedQuery<readonly Run[]>('runs', (c) => c.listRuns()),
      {
        wrapper: wrapperFor([entry('laptop', 5001), entry('office', 5002)]),
      },
    )

    await waitFor(() => {
      const laptop = result.current.records.find((record) => record.connection === 'laptop')
      const office = result.current.records.find((record) => record.connection === 'office')
      expect(laptop?.loading).toBe(false)
      expect(office?.loading).toBe(false)
      expect(office?.error).not.toBeNull()
    })

    const laptop = result.current.records.find((record) => record.connection === 'laptop')
    const office = result.current.records.find((record) => record.connection === 'office')

    expect(laptop?.stale).toBe(false)
    expect(laptop?.data).toEqual([laptopRun])

    expect(office?.stale).toBe(true)
    expect(office?.data).toEqual([officeRun])
    expect(office?.lastUpdatedAt).toBe('2026-08-18T09:30:00Z')
  })

  it('marks a connection stale when its fetch fails even while its health probe still passes', async () => {
    const runtimes: FakeRuntime[] = [
      {
        port: 5001,
        routes: {
          '/api/status': () => statusPayload(),
          // /api/runs missing → 404 → the fetcher rejects.
        },
      },
    ]
    installFetchMock(runtimes)
    primeFederatedCache('laptop', 'runs', [makeRun('run-old', '2026-08-18T08:00:00Z')])

    const { result } = renderHook(
      () => useFederatedQuery<readonly Run[]>('runs', (c) => c.listRuns()),
      {
        wrapper: wrapperFor([entry('laptop', 5001)]),
      },
    )

    await waitFor(() => {
      const laptop = result.current.records[0]
      expect(laptop?.loading).toBe(false)
      expect(laptop?.error).not.toBeNull()
    })
    expect(result.current.records[0]?.stale).toBe(true)
    expect((result.current.records[0]?.data ?? []).map((run) => run.id)).toEqual(['run-old'])
  })
})

describe('useNeedsYouCount', () => {
  it('sums open waits and pending approvals across connections, stale entries included', async () => {
    const runtimes: FakeRuntime[] = [
      {
        port: 5001,
        routes: {
          '/api/status': () => statusPayload(),
          '/api/waits': () => [makeWait('w1', 'run-a'), makeWait('w2', 'run-a')],
          '/api/approvals': () => [
            {
              id: 'ap1',
              request: { capability: 'git.write' },
              decision: { effect: 'ask' },
              requestedAt: new Date().toISOString(),
            },
          ],
        },
      },
      { port: 5002, routes: {}, fail: true },
    ]
    installFetchMock(runtimes)
    primeFederatedCache('office', 'waits', [makeWait('w3', 'run-b')])
    primeFederatedCache('office', 'approvals', [])

    const { result } = renderHook(() => useNeedsYouCount(), {
      wrapper: wrapperFor([entry('laptop', 5001), entry('office', 5002)]),
    })

    await waitFor(() => expect(result.current).toBe(4))
  })
})
