import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../api/client'
import type { JudgmentPackage, WaitCondition } from '../../api/types'
import { ToastProvider } from '../../components/Toast'
import { installFetchMock, withStatus } from '../../test/mockRuntimes'
import { WaitResponseForm } from './WaitResponseForm'

const judgment: JudgmentPackage = {
  experimentId: 'exp-1',
  hypothesis: 'A streaming parser halves ingest latency',
  rubricSummary: 'Latency 60%, correctness 40%',
  killCriteria: ['p95 regression above 5%'],
  survivors: [
    {
      candidateId: 'cand-1',
      title: 'Streaming parser',
      summary: 'Incremental tokenizer with backpressure',
      weightedScore: 0.87,
      artifacts: { branch: 'exp/streaming' },
      keyEvidence: ['p95 latency -48% on the ingest benchmark'],
    },
    {
      candidateId: 'cand-2',
      title: 'Batched parser',
      summary: 'Chunked batch processing',
      weightedScore: 0.61,
      artifacts: {},
      keyEvidence: [],
    },
  ],
  recommendation: 'Advance the streaming parser',
  risks: ['Backpressure untested under burst load'],
  iteration: 2,
  maxIterations: 3,
}

function judgmentWait(): WaitCondition {
  return {
    id: 'wait-1',
    runId: 'run-1',
    nodeId: 'judge',
    kind: 'human-input',
    parameters: { reason: 'EXPERIMENT_JUDGMENT_REQUIRED', judgment },
    request: {
      type: 'single-choice',
      prompt: 'Judge the experiment',
      surface: 'app',
      choices: ['advance:cand-1', 'advance:cand-2', 'iterate', 'need-more-evidence', 'kill'],
    },
    status: 'open',
    createdAt: new Date().toISOString(),
  }
}

function renderForm(wait: WaitCondition, onResolved?: () => void): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://127.0.0.1:5001', token: 't' })
  render(
    <ToastProvider>
      <WaitResponseForm wait={wait} client={client} onResolved={onResolved} />
    </ToastProvider>,
  )
  return client
}

function Providers({ children }: { readonly children: ReactNode }): JSX.Element {
  return <ToastProvider>{children}</ToastProvider>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WaitResponseForm judgment rendering', () => {
  it('renders the judgment package with survivors, scores, and evidence', () => {
    installFetchMock([{ port: 5001, routes: {} }])
    renderForm(judgmentWait())

    expect(screen.getByText(/iteration 2 of 3/i)).toBeInTheDocument()
    expect(screen.getByText('A streaming parser halves ingest latency')).toBeInTheDocument()
    expect(screen.getByText('Streaming parser')).toBeInTheDocument()
    expect(screen.getByText('score 0.87')).toBeInTheDocument()
    expect(screen.getByText('p95 latency -48% on the ingest benchmark')).toBeInTheDocument()
    expect(screen.getByText('Advance the streaming parser')).toBeInTheDocument()
    expect(screen.getByText('Backpressure untested under burst load')).toBeInTheDocument()
    expect(screen.getByText('p95 regression above 5%')).toBeInTheDocument()
  })

  it('labels advance choices with the candidate titles', () => {
    installFetchMock([{ port: 5001, routes: {} }])
    renderForm(judgmentWait())

    expect(screen.getByLabelText('Advance — Streaming parser')).toBeInTheDocument()
    expect(screen.getByLabelText('Advance — Batched parser')).toBeInTheDocument()
    expect(screen.getByLabelText('Iterate')).toBeInTheDocument()
    expect(screen.getByLabelText('Need More Evidence')).toBeInTheDocument()
    expect(screen.getByLabelText('Kill')).toBeInTheDocument()
  })

  it('submits the raw advance:<candidateId> choice value', async () => {
    const bodies: unknown[] = []
    installFetchMock([
      {
        port: 5001,
        routes: {
          '/api/waits/wait-1/respond': (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)))
            return { accepted: true }
          },
        },
      },
    ])
    const onResolved = vi.fn()
    renderForm(judgmentWait(), onResolved)

    fireEvent.click(screen.getByLabelText('Advance — Streaming parser'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(bodies).toEqual([{ value: 'advance:cand-1' }])
  })
})

describe('WaitResponseForm lost-race handling', () => {
  it('shows who won when the respond returns 409', async () => {
    installFetchMock([
      {
        port: 5001,
        routes: {
          '/api/waits/wait-9/respond': () =>
            withStatus(409, {
              accepted: false,
              error: 'already satisfied',
              winner: {
                at: new Date().toISOString(),
                responder: 'alice',
                channel: 'app',
                value: true,
              },
            }),
        },
      },
    ])
    const wait: WaitCondition = {
      id: 'wait-9',
      runId: 'run-9',
      nodeId: 'gate',
      kind: 'approval',
      parameters: {},
      request: { type: 'approval', prompt: 'Ship it?', surface: 'app' },
      status: 'open',
      createdAt: new Date().toISOString(),
    }
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:5001', token: 't' })
    render(
      <Providers>
        <WaitResponseForm wait={wait} client={client} />
      </Providers>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.getByText(/Already answered by alice/)).toBeInTheDocument())
    expect(screen.getByText(/supplemental context/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})
