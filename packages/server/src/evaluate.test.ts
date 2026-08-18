/**
 * Control-plane tests for the designer endpoints (ADR-0026):
 * POST /api/definitions/validate and side-effect-free POST /api/evaluate.
 */

import type { IdGenerator } from '@overture/core'
import { InMemoryEventBus, noopLogger, systemClock } from '@overture/core'
import type { RunCoordinator, Scheduler } from '@overture/orchestrator'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { FakeWorkProvider, makeWorkItem } from '@overture/testkit'
import { InMemoryWorkflowProvider } from '@overture/workflow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalBroker } from './approvals.js'
import { type ControlPlaneHandle, startControlPlane } from './http.js'
import { OvertureService, type OvertureServiceDeps } from './service.js'

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

/** A valid graph whose walk is fully determinable without hypotheticals. */
const GREETER_GRAPH = {
  name: 'greeter',
  entry: 'hello',
  nodes: [
    { id: 'hello', config: { kind: 'action', action: 'workflow.noop' } },
    { id: 'notify', config: { kind: 'action', action: 'work.comment', with: { body: 'hi' } } },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
  ],
  transitions: [
    { id: 'h-n', from: 'hello', to: 'notify', condition: "node.status == 'succeeded'" },
    { id: 'n-d', from: 'notify', to: 'done', condition: "node.status == 'succeeded'" },
  ],
}

const BROKEN_GRAPH = {
  name: 'broken',
  entry: 'a',
  nodes: [{ id: 'a', config: { kind: 'action', action: 'workflow.noop' } }],
  transitions: [{ id: 't', from: 'a', to: 'ghost' }],
}

describe('designer endpoints', () => {
  let handle: ControlPlaneHandle
  let persistence: InMemoryPersistenceProvider
  let serviceDeps: OvertureServiceDeps

  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    })

  beforeEach(async () => {
    persistence = new InMemoryPersistenceProvider()
    const work = new FakeWorkProvider([
      makeWorkItem({
        externalId: 'ISSUE-1',
        state: 'Ready',
        title: 'Do the thing',
        description: 'A well-described item',
      }),
    ])
    const ids = new SequentialIds()
    // Evaluate and validate never touch the run coordinator or scheduler;
    // narrow stubs keep this harness honest about that.
    const scheduler = {
      start: async () => {},
      stop: async () => {},
      activeRunCount: 0,
    } as unknown as Scheduler
    const coordinator = {
      cancel: async () => false,
      activeRunIds: () => [],
    } as unknown as RunCoordinator
    serviceDeps = {
      version: '0.1.0-test',
      evaluateExecutors: { has: (executorId) => executorId === 'available-executor' },
      persistence,
      events: new InMemoryEventBus(),
      scheduler,
      coordinator,
      workflows: new InMemoryWorkflowProvider([]),
      workProviders: new Map([['fake', work]]),
      modelProviders: [],
      agentProviders: [],
      approvals: new ApprovalBroker(ids),
      clock: systemClock,
      ids,
      logger: noopLogger,
    }
    handle = await startControlPlane(new OvertureService(serviceDeps))
  })

  afterEach(async () => {
    await handle.close()
    vi.restoreAllMocks()
  })

  async function saveEnabledGreeter(): Promise<void> {
    await persistence.definitions.save('workflow', 'greeter', GREETER_GRAPH)
    await persistence.definitions.setLifecycle('workflow', 'greeter', 'enabled')
  }

  describe('POST /api/definitions/validate', () => {
    it('returns no issues for a valid workflow graph', async () => {
      const response = await api('/api/definitions/validate', {
        method: 'POST',
        body: JSON.stringify({ kind: 'workflow', document: GREETER_GRAPH }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ issues: [] })
    })

    it('returns validateGraph issues for a broken workflow graph', async () => {
      const body = await (
        await api('/api/definitions/validate', {
          method: 'POST',
          body: JSON.stringify({ kind: 'workflow', document: BROKEN_GRAPH }),
        })
      ).json()
      expect(body.issues.length).toBeGreaterThan(0)
      expect(JSON.stringify(body.issues)).toContain('ghost')
    })

    it('reports shape issues instead of crashing on a malformed document', async () => {
      const body = await (
        await api('/api/definitions/validate', {
          method: 'POST',
          body: JSON.stringify({ kind: 'workflow', document: { name: 'x' } }),
        })
      ).json()
      const paths = body.issues.map((issue: { path: string }) => issue.path)
      expect(paths).toContain('entry')
      expect(paths).toContain('nodes')
      expect(paths).toContain('transitions')
    })

    it('returns no issues for non-workflow kinds', async () => {
      const body = await (
        await api('/api/definitions/validate', {
          method: 'POST',
          body: JSON.stringify({ kind: 'gate-set', document: { whatever: true } }),
        })
      ).json()
      expect(body.issues).toEqual([])
    })

    it('rejects unknown kinds and missing documents', async () => {
      expect(
        (
          await api('/api/definitions/validate', {
            method: 'POST',
            body: JSON.stringify({ kind: 'gadget', document: {} }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await api('/api/definitions/validate', {
            method: 'POST',
            body: JSON.stringify({ kind: 'workflow' }),
          })
        ).status,
      ).toBe(400)
    })
  })

  describe('POST /api/evaluate', () => {
    it('evaluates an enabled workflow against a provider item', async () => {
      await saveEnabledGreeter()
      const response = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ workflowName: 'greeter', itemExternalId: 'fake:ISSUE-1' }),
      })
      expect(response.status).toBe(200)
      const report = await response.json()
      expect(report.workflow).toMatchObject({
        name: 'greeter',
        version: 1,
        lifecycle: 'enabled',
        validationIssues: [],
      })
      expect(report.path.nodes).toEqual(['hello', 'notify', 'done'])
      expect(report.path.stopReason).toBe('terminal:done')
      expect(report.blockers).toEqual([])
      const effects = report.expectedSideEffects.map(
        (effect: { kind: string; description: string }) => effect.kind,
      )
      expect(effects).toContain('action')
      expect(JSON.stringify(report.expectedSideEffects)).toContain('work.comment')
    })

    it('causes zero side effects: no persistence writes, no work mutations', async () => {
      await saveEnabledGreeter()
      const writes = [
        vi.spyOn(persistence.definitions, 'save'),
        vi.spyOn(persistence.definitions, 'setLifecycle'),
        vi.spyOn(persistence.definitions, 'saveSnapshot'),
        vi.spyOn(persistence.runs, 'save'),
        vi.spyOn(persistence.waits, 'save'),
        vi.spyOn(persistence.claims, 'tryClaim'),
        vi.spyOn(persistence.events, 'append'),
        vi.spyOn(persistence.runGraphs, 'save'),
      ]
      const work = serviceDeps.workProviders.get('fake') as FakeWorkProvider
      const workMutations = [
        vi.spyOn(work, 'comment'),
        vi.spyOn(work, 'transition'),
        vi.spyOn(work, 'claim'),
      ]

      const response = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ workflowName: 'greeter', itemExternalId: 'fake:ISSUE-1' }),
      })
      expect(response.status).toBe(200)

      for (const spy of [...writes, ...workMutations]) {
        expect(spy).not.toHaveBeenCalled()
      }
    })

    it('evaluates with an inline item and reports a lifecycle blocker for drafts', async () => {
      await persistence.definitions.save('workflow', 'greeter', GREETER_GRAPH)
      const response = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({
          workflowName: 'greeter',
          item: { externalId: 'HYPO-1', title: 'Hypothetical', state: 'Ready' },
        }),
      })
      expect(response.status).toBe(200)
      const report = await response.json()
      expect(report.workflow.lifecycle).toBe('draft')
      expect(
        report.blockers.some(
          (blocker: { kind: string }) => blocker.kind === 'workflow-not-enabled',
        ),
      ).toBe(true)
      expect(report.path.stopReason).toBe('terminal:done')
    })

    it('returns 404 for an unknown workflow or item', async () => {
      await saveEnabledGreeter()
      const noWorkflow = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ workflowName: 'nope', itemExternalId: 'fake:ISSUE-1' }),
      })
      expect(noWorkflow.status).toBe(404)
      const noItem = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ workflowName: 'greeter', itemExternalId: 'fake:ISSUE-404' }),
      })
      expect(noItem.status).toBe(404)
    })

    it('rejects requests without an item reference', async () => {
      const response = await api('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ workflowName: 'greeter' }),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('item')
    })

    it('returns 503 with a reason when the graph runtime is not assembled', async () => {
      const { evaluateExecutors: _omitted, ...bareDeps } = serviceDeps
      const bareHandle = await startControlPlane(new OvertureService(bareDeps))
      try {
        const response = await fetch(`http://127.0.0.1:${bareHandle.port}/api/evaluate`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bareHandle.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ workflowName: 'greeter', itemExternalId: 'fake:ISSUE-1' }),
        })
        expect(response.status).toBe(503)
        expect((await response.json()).error).toContain('graph runtime')
      } finally {
        await bareHandle.close()
      }
    })
  })

  it('requires auth on both designer routes', async () => {
    for (const route of ['/api/definitions/validate', '/api/evaluate']) {
      const response = await fetch(`http://127.0.0.1:${handle.port}${route}`, { method: 'POST' })
      expect(response.status, route).toBe(401)
    }
  })
})
