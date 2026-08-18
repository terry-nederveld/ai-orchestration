import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionProvider } from '../../api/connection'
import { clearFederatedCache } from '../../api/federation'
import { ToastProvider } from '../../components/Toast'
import { entry, installFetchMock, statusPayload } from '../../test/mockRuntimes'
import { RunDetail } from './RunDetail'

const run = {
  id: 'run-9',
  workItemId: 'gh:ISSUE-9',
  workflowName: 'delivery@3',
  state: 'WAITING_FOR_HUMAN',
  sessionIds: [],
  createdAt: '2026-08-18T09:00:00Z',
  updatedAt: '2026-08-18T11:00:00Z',
  history: [],
}

// As served by GET /api/graph-runs/:id — resultHistory already newest-first.
const graphRunView = {
  run,
  state: {
    runId: 'run-9',
    snapshotId: 'snap-1',
    activeNodeIds: ['ask-user'],
    waitingNodeIds: ['ask-user'],
    nodeResults: {},
    resultHistory: [
      {
        nodeId: 'build',
        attempt: 2,
        status: 'succeeded',
        outputs: { summary: 'built' },
        startedAt: '2026-08-18T10:00:00Z',
        settledAt: '2026-08-18T10:30:00Z',
      },
      {
        nodeId: 'plan',
        attempt: 1,
        status: 'succeeded',
        outputs: { summary: 'planned' },
        startedAt: '2026-08-18T09:10:00Z',
        settledAt: '2026-08-18T09:20:00Z',
      },
    ],
    loopCounters: {},
    activations: {},
    domain: { name: 'building', data: { step: 2 } },
    variables: {},
    specRevision: 3,
    updatedAt: '2026-08-18T11:00:00Z',
  },
  openWaits: [
    {
      id: 'wait-9',
      runId: 'run-9',
      nodeId: 'ask-user',
      kind: 'human-input',
      parameters: {},
      request: { type: 'text', prompt: 'Which color?', surface: 'app' },
      status: 'open',
      createdAt: '2026-08-18T10:45:00Z',
    },
  ],
}

beforeEach(() => {
  clearFederatedCache()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RunDetail for durable graph runs', () => {
  it('renders graph state with the result history newest-first and open waits inline', async () => {
    installFetchMock([
      {
        port: 5001,
        routes: {
          '/api/status': () => statusPayload(),
          '/api/runs/run-9': () => run,
          '/api/runs/run-9/events': () => [],
          '/api/graph-runs/run-9': () => graphRunView,
        },
      },
    ])

    render(
      <MemoryRouter initialEntries={['/runs/run-9?conn=laptop']}>
        <ConnectionProvider initialEntries={[entry('laptop', 5001)]} pollMs={60_000}>
          <ToastProvider>
            <Routes>
              <Route path="/runs/:runId" element={<RunDetail />} />
            </Routes>
          </ToastProvider>
        </ConnectionProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('spec revision 3')).toBeInTheDocument())

    // Run + domain state.
    expect(screen.getByText('Waiting on human')).toBeInTheDocument()
    expect(screen.getByText('building')).toBeInTheDocument()
    expect(screen.getByText('delivery@3')).toBeInTheDocument()

    // Active/waiting node ids (one chip in each list).
    expect(screen.getAllByText('ask-user')).toHaveLength(2)

    // Result history newest-first: build (settled 10:30) before plan (09:20).
    const nodes = screen.getAllByText(/^(build|plan)$/).map((node) => node.textContent)
    expect(nodes).toEqual(['build', 'plan'])
    expect(screen.getByText('attempt 2')).toBeInTheDocument()

    // Expandable outputs render as JSON.
    expect(screen.getByText(/"summary": "built"/)).toBeInTheDocument()

    // Open waits render inline with their response form.
    expect(screen.getByText('Which color?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
  })
})
