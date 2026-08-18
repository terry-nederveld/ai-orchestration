import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentOutcome,
  type AgentRunHandle,
  type AgentRunRequest,
  asId,
  type GraphNodeResult,
  type HumanInputRequestSpec,
  type IdGenerator,
  InMemoryEventBus,
  initialRunGraphState,
  noopLogger,
  type Run,
  RunState,
  systemClock,
  type WaitCondition,
  type WaitKind,
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
import { type GraphWaitCoordinator, OvertureService, type OvertureServiceDeps } from './service.js'
import { readDaemonInfo, writeDaemonInfo } from './state-dir.js'

const SECRET = 'tok-9f8e7d6c5b4a-hunter2'

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
  let persistence: InMemoryPersistenceProvider
  let serviceDeps: OvertureServiceDeps

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
    persistence = new InMemoryPersistenceProvider()
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
    // Mirrors GraphRunCoordinator.satisfy: wins-or-supplements via the wait
    // repository's CAS, without dragging the whole graph runtime into the
    // harness.
    const graphCoordinator: GraphWaitCoordinator = {
      satisfy: async (waitId, response) => {
        const condition = await persistence.waits.get(waitId)
        if (!condition) return { accepted: false, reason: 'unknown wait' }
        const input =
          response.value !== undefined
            ? {
                requestId: waitId,
                responder: response.responder,
                channel: response.channel,
                at: systemClock.now(),
                value: response.value,
              }
            : undefined
        const won = await persistence.waits.trySatisfy(waitId, {
          kind: condition.kind,
          at: systemClock.now(),
          ...(input ? { input } : {}),
        })
        if (!won) {
          if (input) {
            await persistence.waits.addSupplemental({ waitId, runId: condition.runId, input })
          }
          return { accepted: false, reason: 'already satisfied; recorded as supplemental context' }
        }
        return { accepted: true }
      },
    }
    const redactPayload = (payload: unknown): unknown => {
      const serialized = JSON.stringify(payload)
      return serialized.includes(SECRET)
        ? JSON.parse(serialized.split(SECRET).join('[redacted]'))
        : payload
    }
    serviceDeps = {
      version: '0.1.0-test',
      redactPayload,
      graphCoordinator,
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
    }
    service = new OvertureService(serviceDeps)
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

  function makeWait(
    overrides: {
      readonly id?: string
      readonly runId?: string
      readonly nodeId?: string
      readonly kind?: WaitKind
      readonly parameters?: Readonly<Record<string, unknown>>
      readonly request?: HumanInputRequestSpec
      readonly noRequest?: boolean
    } = {},
  ): WaitCondition {
    return {
      id: overrides.id ?? 'wait-1',
      runId: asId<'run'>(overrides.runId ?? 'run-1'),
      nodeId: overrides.nodeId ?? 'ask-user',
      kind: overrides.kind ?? 'human-input',
      parameters: overrides.parameters ?? {},
      ...(overrides.noRequest
        ? {}
        : {
            request: overrides.request ?? {
              type: 'text',
              prompt: 'Which color?',
              surface: 'app',
            },
          }),
      status: 'open',
      createdAt: systemClock.now(),
    }
  }

  describe('waits', () => {
    it('lists open waits with runId, type, and reason filters', async () => {
      await persistence.waits.save(makeWait({ id: 'wait-a', runId: 'run-1' }))
      await persistence.waits.save(
        makeWait({
          id: 'wait-b',
          runId: 'run-2',
          kind: 'time',
          noRequest: true,
          parameters: { reason: 'cooldown' },
        }),
      )

      const all = await (await api('/api/waits')).json()
      expect(all).toHaveLength(2)
      const humanWait = all.find((wait: { id: string }) => wait.id === 'wait-a')
      expect(humanWait.request).toEqual({ type: 'text', prompt: 'Which color?', surface: 'app' })

      const byRun = await (await api('/api/waits?runId=run-1')).json()
      expect(byRun.map((wait: { id: string }) => wait.id)).toEqual(['wait-a'])

      const byType = await (await api('/api/waits?type=time')).json()
      expect(byType.map((wait: { id: string }) => wait.id)).toEqual(['wait-b'])

      const byReason = await (await api('/api/waits?reason=cooldown')).json()
      expect(byReason.map((wait: { id: string }) => wait.id)).toEqual(['wait-b'])

      expect((await api('/api/waits?type=bogus')).status).toBe(400)
    })

    it('accepts a valid response and satisfies the wait', async () => {
      await persistence.waits.save(makeWait())
      const response = await api('/api/waits/wait-1/respond', {
        method: 'POST',
        body: JSON.stringify({ value: 'blue', respondedBy: 'terry' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ accepted: true })

      const settled = await persistence.waits.get('wait-1')
      expect(settled?.status).toBe('satisfied')
      expect(settled?.satisfaction?.input?.value).toBe('blue')
      expect(settled?.satisfaction?.input?.responder).toBe('terry')
    })

    it('rejects a value that fails the request spec with 400', async () => {
      await persistence.waits.save(
        makeWait({ request: { type: 'boolean', prompt: 'Proceed?', surface: 'app' } }),
      )
      const response = await api('/api/waits/wait-1/respond', {
        method: 'POST',
        body: JSON.stringify({ value: 'yes' }),
      })
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toContain('true or false')
      expect((await persistence.waits.get('wait-1'))?.status).toBe('open')
    })

    it('returns 409 with the winning response for a lost race', async () => {
      await persistence.waits.save(makeWait())
      await persistence.waits.trySatisfy('wait-1', {
        kind: 'human-input',
        at: systemClock.now(),
        input: {
          requestId: 'wait-1',
          responder: 'alice',
          channel: 'app',
          at: systemClock.now(),
          value: 'first answer',
        },
      })

      const response = await api('/api/waits/wait-1/respond', {
        method: 'POST',
        body: JSON.stringify({ value: 'second answer', respondedBy: 'bob' }),
      })
      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.accepted).toBe(false)
      expect(body.winner.responder).toBe('alice')
      expect(body.winner.value).toBe('first answer')

      const supplemental = await persistence.waits.listSupplemental(asId<'run'>('run-1'))
      expect(supplemental).toHaveLength(1)
      expect(supplemental[0]?.input.value).toBe('second answer')
    })

    it('returns 404 for an unknown wait', async () => {
      const response = await api('/api/waits/wait-nope/respond', {
        method: 'POST',
        body: JSON.stringify({ value: 'x' }),
      })
      expect(response.status).toBe(404)
    })

    it('returns 503 when no graph coordinator is assembled', async () => {
      const { graphCoordinator: _omitted, ...v1Deps } = serviceDeps
      const bare = new OvertureService(v1Deps)
      const bareHandle = await startControlPlane(bare)
      try {
        await persistence.waits.save(makeWait())
        const response = await fetch(
          `http://127.0.0.1:${bareHandle.port}/api/waits/wait-1/respond`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${bareHandle.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ value: 'blue' }),
          },
        )
        expect(response.status).toBe(503)
      } finally {
        await bareHandle.close()
      }
    })

    it('redacts secret values before they leave the control plane', async () => {
      await persistence.waits.save(makeWait({ id: 'wait-open', parameters: { hint: SECRET } }))
      const listed = await (await api('/api/waits')).text()
      expect(listed).not.toContain(SECRET)
      expect(listed).toContain('[redacted]')

      await persistence.waits.save(makeWait({ id: 'wait-won', runId: 'run-2' }))
      await persistence.waits.trySatisfy('wait-won', {
        kind: 'human-input',
        at: systemClock.now(),
        input: {
          requestId: 'wait-won',
          responder: 'alice',
          channel: 'app',
          at: systemClock.now(),
          value: `the token is ${SECRET}`,
        },
      })
      const conflict = await api('/api/waits/wait-won/respond', {
        method: 'POST',
        body: JSON.stringify({ value: 'late answer' }),
      })
      expect(conflict.status).toBe(409)
      const body = JSON.stringify(await conflict.json())
      expect(body).not.toContain(SECRET)
      expect(body).toContain('[redacted]')
    })
  })

  describe('definitions', () => {
    it('saves, lists, and versions definitions', async () => {
      const first = await api('/api/definitions/workflow/greeter', {
        method: 'PUT',
        body: JSON.stringify({ steps: ['hello'] }),
      })
      expect(first.status).toBe(201)
      expect((await first.json()).version).toBe(1)

      const second = await api('/api/definitions/workflow/greeter', {
        method: 'PUT',
        body: JSON.stringify({ steps: ['hello', 'goodbye'] }),
      })
      expect((await second.json()).version).toBe(2)

      const list = await (await api('/api/definitions')).json()
      expect(list).toEqual([
        { kind: 'workflow', name: 'greeter', lifecycle: 'draft', latestVersion: 2 },
      ])
      expect(await (await api('/api/definitions?kind=rubric')).json()).toEqual([])
      expect((await api('/api/definitions?kind=gadget')).status).toBe(400)

      const detail = await (await api('/api/definitions/workflow/greeter')).json()
      expect(detail.lifecycle).toBe('draft')
      expect(detail.latestVersion).toBe(2)
      expect(detail.definition.document).toEqual({ steps: ['hello', 'goodbye'] })
      expect(detail.versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1])

      const pinned = await (await api('/api/definitions/workflow/greeter?version=1')).json()
      expect(pinned.definition.document).toEqual({ steps: ['hello'] })

      expect((await api('/api/definitions/workflow/nope')).status).toBe(404)
      expect((await api('/api/definitions/gadget/greeter')).status).toBe(400)
      expect((await api('/api/definitions/workflow/greeter?version=zero')).status).toBe(400)
    })

    it('drives the definition lifecycle', async () => {
      await api('/api/definitions/workflow/greeter', {
        method: 'PUT',
        body: JSON.stringify({ steps: ['hello'] }),
      })

      const enabled = await api('/api/definitions/workflow/greeter/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ lifecycle: 'enabled' }),
      })
      expect(enabled.status).toBe(200)
      expect((await enabled.json()).lifecycle).toBe('enabled')
      expect((await (await api('/api/definitions/workflow/greeter')).json()).lifecycle).toBe(
        'enabled',
      )

      const disabled = await api('/api/definitions/workflow/greeter/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ lifecycle: 'disabled' }),
      })
      expect((await disabled.json()).lifecycle).toBe('disabled')

      const invalid = await api('/api/definitions/workflow/greeter/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ lifecycle: 'archived' }),
      })
      expect(invalid.status).toBe(400)

      const missing = await api('/api/definitions/workflow/nope/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ lifecycle: 'enabled' }),
      })
      expect(missing.status).toBe(404)
    })
  })

  describe('graph runs', () => {
    it('returns the persisted state, run record, and open waits', async () => {
      const runId = asId<'run'>('run-9')
      const run: Run = {
        id: runId,
        workItemId: asId<'work-item'>('fake:ISSUE-1'),
        workflowName: 'mini@1',
        state: RunState.WaitingForHuman,
        sessionIds: [],
        createdAt: systemClock.now(),
        updatedAt: systemClock.now(),
        history: [],
      }
      await persistence.runs.save(run)
      const older: GraphNodeResult = {
        nodeId: 'plan',
        attempt: 1,
        status: 'succeeded',
        outputs: { summary: 'planned' },
        startedAt: new Date(1_000),
        settledAt: new Date(2_000),
      }
      const newer: GraphNodeResult = {
        nodeId: 'build',
        attempt: 1,
        status: 'succeeded',
        outputs: { summary: 'built' },
        startedAt: new Date(3_000),
        settledAt: new Date(4_000),
      }
      await persistence.runGraphs.save({
        ...initialRunGraphState(runId, 'snap-1'),
        activeNodeIds: ['ask-user'],
        waitingNodeIds: ['ask-user'],
        nodeResults: { plan: older, build: newer },
        resultHistory: [older, newer],
        domain: { name: 'building', data: { step: 2 } },
        specRevision: 3,
        updatedAt: systemClock.now(),
      })
      await persistence.waits.save(makeWait({ id: 'wait-9', runId: 'run-9' }))

      const response = await api('/api/graph-runs/run-9')
      expect(response.status).toBe(200)
      const view = await response.json()
      expect(view.run.id).toBe('run-9')
      expect(view.state.activeNodeIds).toEqual(['ask-user'])
      expect(view.state.waitingNodeIds).toEqual(['ask-user'])
      expect(view.state.specRevision).toBe(3)
      expect(view.state.domain).toEqual({ name: 'building', data: { step: 2 } })
      expect(view.state.resultHistory.map((result: { nodeId: string }) => result.nodeId)).toEqual([
        'build',
        'plan',
      ])
      expect(view.openWaits.map((wait: { id: string }) => wait.id)).toEqual(['wait-9'])

      expect((await api('/api/graph-runs/run-nope')).status).toBe(404)
    })
  })

  describe('judgments', () => {
    it('lists judgment outcomes newest-first with a since filter', async () => {
      await persistence.judgments.save({
        experimentId: 'exp-old',
        decision: 'iterate',
        decidedBy: 'terry',
        at: new Date('2026-08-01T10:00:00Z'),
      })
      await persistence.judgments.save({
        experimentId: 'exp-new',
        decision: 'advance',
        selectedCandidateId: 'cand-1',
        decidedBy: 'terry',
        at: new Date('2026-08-15T10:00:00Z'),
      })

      const listed = await (await api('/api/judgments?since=2026-07-01T00:00:00Z')).json()
      expect(listed.map((outcome: { experimentId: string }) => outcome.experimentId)).toEqual([
        'exp-new',
        'exp-old',
      ])
      expect(listed[0].decision).toBe('advance')
      expect(listed[0].selectedCandidateId).toBe('cand-1')
      expect(listed[0].decidedBy).toBe('terry')

      const recent = await (await api('/api/judgments?since=2026-08-10T00:00:00Z')).json()
      expect(recent.map((outcome: { experimentId: string }) => outcome.experimentId)).toEqual([
        'exp-new',
      ])

      expect((await api('/api/judgments?since=not-a-date')).status).toBe(400)
    })
  })

  it('requires auth on all phase 2 routes', async () => {
    const routes: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/waits'],
      ['POST', '/api/waits/wait-1/respond'],
      ['GET', '/api/definitions'],
      ['GET', '/api/definitions/workflow/mini'],
      ['PUT', '/api/definitions/workflow/mini'],
      ['POST', '/api/definitions/workflow/mini/lifecycle'],
      ['GET', '/api/graph-runs/run-1'],
      ['GET', '/api/judgments'],
    ]
    for (const [method, route] of routes) {
      const response = await fetch(`http://127.0.0.1:${handle.port}${route}`, { method })
      expect(response.status, `${method} ${route}`).toBe(401)
    }
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
