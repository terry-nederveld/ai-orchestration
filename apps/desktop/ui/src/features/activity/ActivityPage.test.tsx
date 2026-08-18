import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionProvider } from '../../api/connection'
import { clearFederatedCache, primeFederatedCache } from '../../api/federation'
import type { Run } from '../../api/types'
import { ToastProvider } from '../../components/Toast'
import { entry, installFetchMock, statusPayload } from '../../test/mockRuntimes'
import { ActivityPage } from './ActivityPage'

function makeRun(id: string, workItemId: string, updatedAt: string, state = 'RUNNING'): Run {
  return {
    id,
    workItemId,
    workflowName: 'delivery',
    state: state as Run['state'],
    sessionIds: [],
    createdAt: updatedAt,
    updatedAt,
    history: [],
  }
}

function renderPage(entries: Parameters<typeof ConnectionProvider>[0]['initialEntries']): void {
  render(
    <MemoryRouter>
      <ConnectionProvider initialEntries={entries} pollMs={60_000}>
        <ToastProvider>
          <ActivityPage />
        </ToastProvider>
      </ConnectionProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearFederatedCache()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ActivityPage', () => {
  it('aggregates runs across connections newest-first, marks stale entries, and flags runs needing you', async () => {
    const newestRun = makeRun('run-new', 'gh:ISSUE-2', '2026-08-18T12:00:00Z')
    const waitingRun = makeRun(
      'run-waiting',
      'gh:ISSUE-1',
      '2026-08-18T10:00:00Z',
      'WAITING_FOR_HUMAN',
    )
    const staleRun = makeRun('run-office', 'jira:PROJ-7', '2026-08-18T11:00:00Z')

    installFetchMock([
      {
        port: 5001,
        routes: {
          '/api/status': () => statusPayload({ workSources: ['gh'] }),
          '/api/runs': () => [waitingRun, newestRun],
          '/api/waits': () => [
            {
              id: 'wait-1',
              runId: 'run-waiting',
              nodeId: 'ask-user',
              kind: 'human-input',
              parameters: {},
              request: { type: 'text', prompt: 'Which color?', surface: 'app' },
              status: 'open',
              createdAt: '2026-08-18T10:00:00Z',
            },
          ],
          '/api/work/gh/items': () => [
            { externalId: 'ISSUE-1', title: 'Fix login flow' },
            { externalId: 'ISSUE-2', title: 'Add audit log' },
          ],
        },
      },
      { port: 5002, routes: {}, fail: true },
    ])
    // The office runtime is down; its last-known feed data is shown stale.
    primeFederatedCache('office', 'runs', [staleRun], '2026-08-18T11:05:00Z')
    primeFederatedCache('office', 'waits', [])

    renderPage([entry('laptop', 5001), entry('office', 5002)])

    await waitFor(() => expect(screen.getByText('Add audit log')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('jira:PROJ-7')).toBeInTheDocument())

    // Work item grouping: titles prominent, external ids shown.
    expect(screen.getByText('Fix login flow')).toBeInTheDocument()
    expect(screen.getByText('gh:ISSUE-1')).toBeInTheDocument()

    // Newest-first group ordering by latest run update.
    const groupIds = screen
      .getAllByText(/^(gh:ISSUE-1|gh:ISSUE-2|jira:PROJ-7)$/)
      .map((node) => node.textContent)
    expect(groupIds).toEqual(['gh:ISSUE-2', 'jira:PROJ-7', 'gh:ISSUE-1'])

    // Source connection is an attribute of every row.
    expect(screen.getAllByText('laptop').length).toBeGreaterThanOrEqual(2)

    // The unreachable runtime's row is marked stale, and never blocks the rest.
    expect(screen.getAllByText('office').length).toBe(1)
    expect(screen.getByText('stale')).toBeInTheDocument()

    // The run with an open wait carries the NEEDS YOU flag.
    expect(screen.getByText('NEEDS YOU')).toBeInTheDocument()
  })
})
