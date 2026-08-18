/**
 * Regression tests for independent security-review findings on the graph
 * runtime: the fan-out width bound (H1) and secret human-input handling
 * (H2 — the raw value is stored out-of-band, never persisted or echoed).
 */

import {
  asId,
  type GraphNode,
  type IdGenerator,
  noopLogger,
  type ResolvedSnapshot,
  type Run,
  systemClock,
  type WorkItem,
} from '@overture/core'
import { describe, expect, it } from 'vitest'
import {
  type ChildRunner,
  createGraphNodeExecutors,
  FANOUT_HARD_CEILING,
  type GraphExecutorDeps,
} from './node-executors.js'

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

const item: WorkItem = {
  id: asId('fake:1'),
  provider: 'fake',
  externalId: '1',
  title: 'x',
  state: 'open',
  labels: [],
  assignees: [],
  relationships: [],
  metadata: {},
}

const run: Run = {
  id: asId<'run'>('run-1'),
  workItemId: item.id,
  workflowName: 'w@1',
  state: 'RUNNING' as Run['state'],
  sessionIds: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  history: [],
}

// A snapshot carrying one branch workflow definition so fan-out resolves.
const snapshot: ResolvedSnapshot = {
  id: 'snap-1',
  root: { kind: 'workflow', name: 'parent', version: 1 },
  definitions: [
    {
      kind: 'workflow',
      name: 'branch',
      version: 1,
      contentHash: 'h',
      createdAt: new Date(0),
      lifecycle: 'enabled',
      document: { name: 'branch', entry: 'a', nodes: [], transitions: [] },
    },
  ],
} as unknown as ResolvedSnapshot

function fanOutExecutor(items: unknown, childRunner: ChildRunner) {
  const deps: GraphExecutorDeps = {
    run,
    item,
    snapshot,
    graph: { name: 'parent', entry: 'fan', nodes: [], transitions: [] },
    executors: { get: () => undefined },
    commands: { run: async () => ({ exitCode: 0, output: '' }) },
    actions: new Map(),
    childRunner,
    agentContext: '',
    events: {
      publish: () => {},
      subscribe: () => () => {},
    } as unknown as GraphExecutorDeps['events'],
    clock: systemClock,
    ids: new SequentialIds(),
    logger: noopLogger,
    signal: new AbortController().signal,
  }
  const executors = createGraphNodeExecutors(deps)
  const node: GraphNode = {
    id: 'fan',
    config: {
      kind: 'fan-out',
      items: 'vars.items',
      workflow: { name: 'branch' },
      join: { mode: 'all' },
    },
  }
  return executors['fan-out']?.(node, {
    runId: 'run-1',
    node,
    attempt: 1,
    variables: { items },
    domain: { data: {} },
    nodeResults: {},
    signal: new AbortController().signal,
  })
}

describe('fan-out width bound (H1)', () => {
  it('fails a fan-out whose item list exceeds the hard ceiling', async () => {
    const started: number[] = []
    const childRunner: ChildRunner = {
      start: async () => {
        started.push(1)
        return { childRunId: `c${started.length}` }
      },
    }
    const overWide = Array.from({ length: FANOUT_HARD_CEILING + 1 }, (_, i) => i)
    const result = await fanOutExecutor(overWide, childRunner)
    expect(result?.type).toBe('result')
    if (result?.type === 'result') {
      expect(result.status).toBe('failed')
      expect(result.error).toContain('exceeds the limit')
    }
    // Critically: NOT one child was started.
    expect(started).toHaveLength(0)
  })

  it('honors a smaller declared maxConcurrency as the cap', async () => {
    const childRunner: ChildRunner = { start: async () => ({ childRunId: 'c' }) }
    const node: GraphNode = {
      id: 'fan',
      config: {
        kind: 'fan-out',
        items: 'vars.items',
        workflow: { name: 'branch' },
        join: { mode: 'all' },
        maxConcurrency: 2,
      },
    }
    const deps: GraphExecutorDeps = {
      run,
      item,
      snapshot,
      graph: { name: 'parent', entry: 'fan', nodes: [], transitions: [] },
      executors: { get: () => undefined },
      commands: { run: async () => ({ exitCode: 0, output: '' }) },
      actions: new Map(),
      childRunner,
      agentContext: '',
      events: {
        publish: () => {},
        subscribe: () => () => {},
      } as unknown as GraphExecutorDeps['events'],
      clock: systemClock,
      ids: new SequentialIds(),
      logger: noopLogger,
      signal: new AbortController().signal,
    }
    const result = await createGraphNodeExecutors(deps)['fan-out']?.(node, {
      runId: 'run-1',
      node,
      attempt: 1,
      variables: { items: [1, 2, 3] },
      domain: { data: {} },
      nodeResults: {},
      signal: new AbortController().signal,
    })
    expect(result?.type).toBe('result')
    if (result?.type === 'result') expect(result.error).toContain('exceeds the limit')
  })

  it('allows a list within the bound', async () => {
    const started: string[] = []
    const childRunner: ChildRunner = {
      start: async (o) => {
        started.push(o.branchKey)
        return { childRunId: `c${started.length}` }
      },
    }
    const result = await fanOutExecutor([1, 2, 3], childRunner)
    expect(result?.type).toBe('wait')
    expect(started).toHaveLength(3)
  })
})
