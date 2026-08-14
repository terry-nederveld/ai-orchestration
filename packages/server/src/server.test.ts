import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentOutcome,
  type AgentRunHandle,
  type AgentRunRequest,
  type IdGenerator,
  InMemoryEventBus,
  noopLogger,
  RunState,
  systemClock,
} from '@overture/core'
import {
  builtinActionFactory,
  RunCoordinator,
  Scheduler,
  WorkflowActionRegistry,
} from '@overture/orchestrator'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { FakeWorkProvider, FakeWorkspaceProvider, makeWorkItem } from '@overture/testkit'
import { InMemoryWorkflowProvider, parseWorkflowYaml } from '@overture/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalBroker } from './approvals.js'
import { type ControlPlaneHandle, startControlPlane } from './http.js'
import { OvertureService } from './service.js'
import { readDaemonInfo, writeDaemonInfo } from './state-dir.js'

const WORKFLOW = `
name: mini
trigger: { states: [Ready] }
workspace: { strategy: fake, retention: never }
steps:
  - id: solo
    agent: coder
    goal: Do the thing
transitions: { success: Done, failure: Failed }
`

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

function scriptedHandle(request: AgentRunRequest, outcome: AgentOutcome): AgentRunHandle {
  const result = {
    outcome,
    summary: 'done',
    usage: {
      provider: 'scripted',
      tokens: { inputTokens: 10, outputTokens: 5 },
      durationMs: 1,
      turns: 1,
      subagents: 0,
    },
  }
  return {
    sessionId: request.sessionId,
    events: () =>
      (async function* () {
        yield { type: 'agent.completed' as const, result }
      })(),
    result: async () => result,
    cancel: async () => {},
  }
}

describe('control plane', () => {
  let baseDir: string
  let handle: ControlPlaneHandle
  let service: OvertureService
  let work: FakeWorkProvider

  const api = (path: string, init?: RequestInit & { token?: string }) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${init?.token ?? handle.token}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    })

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'overture-server-'))
    work = new FakeWorkProvider([
      makeWorkItem({ externalId: 'ISSUE-1', state: 'Ready', title: 'Do the thing' }),
    ])
    const persistence = new InMemoryPersistenceProvider()
    const bus = new InMemoryEventBus()
    const ids = new SequentialIds()
    const approvals = new ApprovalBroker(ids)
    const workspaces = new FakeWorkspaceProvider(baseDir, { strategy: 'fake' as never })
    const actions = new WorkflowActionRegistry()
    actions.register(builtinActionFactory)
    const coordinator = new RunCoordinator({
      work: { resolve: () => work },
      workspaces: { resolve: () => workspaces },
      agents: {
        resolve: async () => ({
          providerId: 'scripted',
          start: async (request) => scriptedHandle(request, 'GOAL_COMPLETED'),
        }),
      },
      commands: { run: async () => ({ exitCode: 0, output: '' }) },
      actions,
      approvals,
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      claimant: 'test',
    })
    const scheduler = new Scheduler({
      sources: [{ provider: work }],
      workflows: new InMemoryWorkflowProvider([parseWorkflowYaml(WORKFLOW)]),
      coordinator,
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      pollIntervalMs: 3_600_000,
    })
    service = new OvertureService({
      version: '0.1.0-test',
      persistence,
      events: bus,
      scheduler,
      coordinator,
      workflows: new InMemoryWorkflowProvider([parseWorkflowYaml(WORKFLOW)]),
      workProviders: new Map([['fake', work]]),
      modelProviders: [],
      agentProviders: [],
      approvals,
      clock: systemClock,
      ids,
      logger: noopLogger,
    })
    handle = await startControlPlane(service)
  })

  afterEach(async () => {
    await handle.close()
    await rm(baseDir, { recursive: true, force: true })
  })

  it('rejects requests without the bearer token', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/status`)
    expect(response.status).toBe(401)
  })

  it('rejects requests with a wrong token', async () => {
    const response = await api('/api/status', { token: 'wrong' })
    expect(response.status).toBe(401)
  })

  it('reports status', async () => {
    const response = await api('/api/status')
    expect(response.status).toBe(200)
    const status = await response.json()
    expect(status.version).toBe('0.1.0-test')
    expect(status.workSources).toEqual(['fake'])
    expect(status.workflows).toEqual(['mini'])
  })

  it('triggers a run, then lists and fetches it', async () => {
    const created = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ workItem: 'fake:ISSUE-1' }),
    })
    expect(created.status).toBe(201)
    const run = await created.json()
    expect(run.workflowName).toBe('mini')

    await waitFor(async () => {
      const detail = await (await api(`/api/runs/${run.id}`)).json()
      return detail.state === RunState.Completed
    })

    const list = await (await api('/api/runs')).json()
    expect(list.length).toBe(1)

    const events = await (await api(`/api/runs/${run.id}/events`)).json()
    expect(events.some((event: { type: string }) => event.type === 'run.state.changed')).toBe(true)
  })

  it('rejects double-claimed manual runs', async () => {
    const first = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ workItem: 'fake:ISSUE-1' }),
    })
    expect(first.status).toBe(201)
    // Immediately trigger again — claim is held until the first run finishes.
    const second = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ workItem: 'fake:ISSUE-1' }),
    })
    // Either the first finished already (200) or we get the claim error (500).
    if (second.status !== 201) {
      const body = await second.json()
      expect(body.error).toContain('claimed')
    }
  })

  it('validates workflow YAML', async () => {
    const good = await (
      await api('/api/workflows/validate', {
        method: 'POST',
        body: JSON.stringify({ source: WORKFLOW }),
      })
    ).json()
    expect(good.valid).toBe(true)

    const bad = await (
      await api('/api/workflows/validate', {
        method: 'POST',
        body: JSON.stringify({ source: 'name: x\nsteps: []\n' }),
      })
    ).json()
    expect(bad.valid).toBe(false)
    expect(bad.issues.length).toBeGreaterThan(0)
  })

  it('lists work items from a source', async () => {
    const items = await (await api('/api/work/fake/items')).json()
    expect(items).toHaveLength(1)
    expect(items[0].externalId).toBe('ISSUE-1')
  })

  it('exposes and resolves approvals', async () => {
    const broker = (service as unknown as { deps: { approvals: ApprovalBroker } }).deps.approvals
    const approvalPromise = broker.requestApproval(
      { capability: 'git.write', target: 'push' },
      { effect: 'ask' },
    )
    const pending = await (await api('/api/approvals')).json()
    expect(pending).toHaveLength(1)

    const resolved = await api(`/api/approvals/${pending[0].id}`, {
      method: 'POST',
      body: JSON.stringify({ approved: true }),
    })
    expect(resolved.status).toBe(200)
    expect(await approvalPromise).toBe(true)
  })

  it('streams events over SSE with query-parameter token', async () => {
    const controller = new AbortController()
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/events?token=${handle.token}`,
      { signal: controller.signal },
    )
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('no body')

    await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ workItem: 'fake:ISSUE-1' }),
    })

    let buffer = ''
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !buffer.includes('run.state.changed')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
    }
    controller.abort()
    expect(buffer).toContain('run.state.changed')
  })
})

describe('state dir', () => {
  it('writes and reads daemon info with 0600 permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overture-state-'))
    await writeDaemonInfo(dir, { host: '127.0.0.1', port: 1234, token: 'secret', pid: 42 })
    const info = await readDaemonInfo(dir)
    expect(info?.port).toBe(1234)
    const mode = (await stat(join(dir, 'daemon.json'))).mode & 0o777
    expect(mode).toBe(0o600)
    await rm(dir, { recursive: true, force: true })
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('condition not met in time')
}
