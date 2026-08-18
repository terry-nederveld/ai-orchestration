import type {
  ContextResolver,
  InstructionProvider,
  MappingRuleSet,
  WorkflowGraph,
  WorkItem,
} from '@overture/core'
import { DefinitionKind } from '@overture/core'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { type EvaluatePorts, evaluateWorkflow } from './evaluate.js'

/** Small branching graph: agent → conditional → gate → action → terminal. */
const evalGraph: WorkflowGraph = {
  name: 'eval-flow',
  entry: 'triage',
  defaultProfile: { name: 'default-profile' },
  nodes: [
    {
      id: 'triage',
      config: {
        kind: 'agent',
        goal: 'Assess the work item',
        outputSchema: { type: 'object', properties: { risky: { type: 'boolean' } } },
      },
    },
    {
      id: 'gate',
      config: { kind: 'gate', gateSet: { name: 'dor' } },
      onEnter: { project: 'In Progress' },
    },
    {
      id: 'notify',
      config: {
        kind: 'action',
        action: 'work_item.comment',
        with: { body: '$expr:vars.work_title' },
      },
    },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
    { id: 'skip-done', config: { kind: 'terminal', outcome: 'completed' } },
  ],
  transitions: [
    { id: 'risky', from: 'triage', to: 'gate', condition: 'outputs.risky == true' },
    { id: 'safe', from: 'triage', to: 'skip-done', condition: 'outputs.risky == false' },
    { id: 'g-ok', from: 'gate', to: 'notify', condition: "node.status == 'succeeded'" },
    { id: 'n-done', from: 'notify', to: 'done' },
  ],
}

const dorGateSet = {
  name: 'dor',
  gates: [
    {
      id: 'ready',
      description: 'Item is ready and was assessed',
      kind: 'deterministic',
      check: "item.state == 'Ready' && results.triage.outputs.assessed == true",
      required: true,
    },
  ],
}

async function seed(
  graph: WorkflowGraph,
  extraDefinitions: Array<{
    kind: DefinitionKind
    name: string
    document: Record<string, unknown>
  }> = [],
): Promise<InMemoryPersistenceProvider> {
  const persistence = new InMemoryPersistenceProvider()
  await persistence.definitions.save(
    DefinitionKind.Workflow,
    graph.name,
    graph as unknown as Record<string, unknown>,
  )
  await persistence.definitions.setLifecycle(DefinitionKind.Workflow, graph.name, 'enabled')
  await persistence.definitions.save(DefinitionKind.AgentProfile, 'default-profile', {
    name: 'default-profile',
    fragment: { primary: { executor: 'scripted' } },
  })
  await persistence.definitions.setLifecycle(
    DefinitionKind.AgentProfile,
    'default-profile',
    'enabled',
  )
  for (const definition of extraDefinitions) {
    await persistence.definitions.save(definition.kind, definition.name, definition.document)
    await persistence.definitions.setLifecycle(definition.kind, definition.name, 'enabled')
  }
  return persistence
}

function makeItem(): WorkItem {
  return makeWorkItem({
    externalId: 'ISSUE-1',
    title: 'Add export feature',
    description: 'Users need CSV export.',
    state: 'Ready',
    labels: ['export'],
  })
}

const ruleSet: MappingRuleSet = {
  name: 'default',
  rules: [
    {
      id: 'export-items',
      priority: 10,
      when: { condition: { field: 'labels', operator: 'contains', value: 'export' } },
      repositories: [{ repository: { locator: 'acme/exporter' }, role: 'primary' }],
    },
    {
      id: 'catch-all',
      priority: 1,
      when: { condition: { field: 'provider', operator: 'equals', value: 'fake' } },
      repositories: [{ repository: { locator: 'acme/monolith' }, role: 'docs' }],
    },
  ],
}

const fakeInstructionProvider: InstructionProvider = {
  id: 'fake-instructions',
  discover: async () => [
    {
      source: 'CLAUDE.md',
      scope: 'repository',
      path: '/repo/CLAUDE.md',
      relativePath: 'CLAUDE.md',
      content: 'Follow the house style.',
      contentHash: 'hash-1',
      precedence: 50,
      providerId: 'fake-instructions',
    },
  ],
}

const fakeContextResolver: ContextResolver = {
  id: 'fake-context',
  resolve: async (request) => [
    {
      resolverId: 'fake-context',
      kind: 'work-item',
      title: `Work item ${request.item.externalId}`,
      content: request.item.description ?? request.item.title,
      priority: 100,
      provenance: 'fake work provider',
    },
  ],
}

function makePorts(
  persistence: InMemoryPersistenceProvider,
  overrides: Partial<EvaluatePorts> = {},
): EvaluatePorts {
  return {
    definitions: persistence.definitions,
    executors: { has: (id) => id === 'scripted' },
    mapping: { getRuleSet: async () => ruleSet },
    instructionProviders: [fakeInstructionProvider],
    repositoryPaths: ['/repo'],
    contextResolvers: [fakeContextResolver],
    ...overrides,
  }
}

describe('evaluateWorkflow', () => {
  it('produces a full dry-run report when hypothetical outputs drive the walk', async () => {
    const persistence = await seed(evalGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    const report = await evaluateWorkflow(
      {
        item: makeItem(),
        workflowName: 'eval-flow',
        hypotheticalOutputs: { triage: { risky: true, assessed: true } },
      },
      makePorts(persistence),
    )

    expect(report.workflow).toEqual({
      name: 'eval-flow',
      version: 1,
      lifecycle: 'enabled',
      validationIssues: [],
    })
    expect(report.matching.selection).toBe('explicit')
    expect(report.matching.rationale).toContain("'eval-flow'@1")

    expect(report.repositories.resolved).toEqual([
      {
        repository: { locator: 'acme/exporter' },
        role: 'primary',
        resolvedBy: 'rule:export-items',
      },
      { repository: { locator: 'acme/monolith' }, role: 'docs', resolvedBy: 'rule:catch-all' },
    ])
    expect(report.repositories.rulesEvaluated).toEqual([
      { ruleId: 'export-items', priority: 10, matched: true, onConflict: 'merge' },
      { ruleId: 'catch-all', priority: 1, matched: true, onConflict: 'merge' },
    ])

    expect(report.instructions).toEqual([
      {
        providerId: 'fake-instructions',
        source: 'CLAUDE.md',
        scope: 'repository',
        path: '/repo/CLAUDE.md',
        precedence: 50,
      },
    ])
    expect(report.contextPreview.fragments).toHaveLength(1)
    expect(report.contextPreview.fragments[0]?.resolverId).toBe('fake-context')
    expect(report.contextPreview.totalChars).toBeGreaterThan(0)

    expect(report.gates).toEqual([
      {
        nodeId: 'gate',
        gateSetName: 'dor',
        gateSetVersion: 1,
        gates: [
          {
            gateId: 'ready',
            kind: 'deterministic',
            required: true,
            outcome: 'pass',
            reason: 'expression true',
          },
        ],
      },
    ])

    // The conditional branch on outputs.risky and the gate pass are both
    // decided from the hypothetical outputs.
    expect(report.path).toEqual({
      nodes: ['triage', 'gate', 'notify', 'done'],
      stopReason: 'terminal:done',
    })

    expect(report.profiles).toEqual([
      {
        nodeId: 'triage',
        profileName: 'default-profile',
        primaryExecutor: 'scripted',
        primaryAvailable: true,
        fallbackChain: [],
        satisfiable: true,
      },
    ])

    expect(report.expectedSideEffects.map((effect) => [effect.nodeId, effect.kind])).toEqual([
      ['triage', 'agent-session'],
      ['gate', 'projection'],
      ['notify', 'action'],
    ])
    const action = report.expectedSideEffects[2]
    expect(action?.details?.['action']).toBe('work_item.comment')
    expect(action?.details?.['args']).toEqual({ body: 'Add export feature' })

    expect(report.blockers).toEqual([])
  })

  it('stops indeterminate without hypothetical outputs', async () => {
    const persistence = await seed(evalGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    const report = await evaluateWorkflow(
      { item: makeItem(), workflowName: 'eval-flow' },
      makePorts(persistence),
    )

    expect(report.path).toEqual({ nodes: [], stopReason: 'indeterminate:triage' })
    // The boundary node's would-be side effect is still described.
    expect(report.expectedSideEffects).toEqual([
      {
        nodeId: 'triage',
        kind: 'agent-session',
        description: "agent session would run for node 'triage' with profile 'default-profile'",
      },
    ])
    expect(report.gates[0]?.gates[0]?.outcome).toBe('indeterminate')
    expect(report.gates[0]?.gates[0]?.reason).toContain('triage')
    expect(report.blockers).toEqual([])
  })

  it('reports a blocker for a disabled workflow', async () => {
    const persistence = await seed(evalGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    await persistence.definitions.setLifecycle(DefinitionKind.Workflow, 'eval-flow', 'disabled')

    const report = await evaluateWorkflow(
      { item: makeItem(), workflowName: 'eval-flow' },
      makePorts(persistence),
    )

    expect(report.workflow.lifecycle).toBe('disabled')
    expect(report.blockers).toContainEqual({
      kind: 'workflow-not-enabled',
      message: "workflow 'eval-flow' is disabled; only enabled workflows start new runs",
    })
  })

  it('reports a blocker when no executor can satisfy an agent profile', async () => {
    const persistence = await seed(evalGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    const report = await evaluateWorkflow(
      { item: makeItem(), workflowName: 'eval-flow' },
      makePorts(persistence, { executors: { has: () => false } }),
    )

    expect(report.profiles[0]?.satisfiable).toBe(false)
    expect(report.profiles[0]?.primaryAvailable).toBe(false)
    expect(report.blockers.map((blocker) => blocker.kind)).toContain('missing-executor')
  })

  it('reports a blocker when a coding workflow resolves no repository', async () => {
    const codingGraph: WorkflowGraph = {
      ...evalGraph,
      name: 'coding-flow',
      workspace: { strategy: 'worktree' },
    }
    const persistence = await seed(codingGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    const report = await evaluateWorkflow(
      {
        item: makeWorkItem({ externalId: 'ISSUE-2', title: 'Orphan item', state: 'Ready' }),
        workflowName: 'coding-flow',
      },
      makePorts(persistence, { mapping: { getRuleSet: async () => undefined } }),
    )

    expect(report.repositories.resolved).toHaveLength(0)
    expect(report.blockers.map((blocker) => blocker.kind)).toContain('no-repository')
  })

  it('never invokes a write path on any injected port', async () => {
    const persistence = await seed(evalGraph, [
      { kind: DefinitionKind.GateSet, name: 'dor', document: dorGateSet },
    ])
    const calls: string[] = []
    const recording = <T extends object>(target: T, label: string): T =>
      new Proxy(target, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            calls.push(`${label}.${String(prop)}`)
            return value.apply(obj, args)
          }
        },
      })

    const workReader = {
      get: async (): Promise<WorkItem> => makeItem(),
    }
    const report = await evaluateWorkflow(
      {
        item: makeItem(),
        workflowName: 'eval-flow',
        hypotheticalOutputs: { triage: { risky: true, assessed: true } },
      },
      {
        definitions: recording(persistence.definitions, 'definitions'),
        executors: recording({ has: (id: string) => id === 'scripted' }, 'executors'),
        mapping: recording({ getRuleSet: async () => ruleSet }, 'mapping'),
        instructionProviders: [recording(fakeInstructionProvider, 'instructions')],
        repositoryPaths: ['/repo'],
        contextResolvers: [recording(fakeContextResolver, 'context')],
        work: recording(workReader, 'work'),
      },
    )
    expect(report.path.stopReason).toBe('terminal:done')

    // Only read-method names may ever be invoked on the ports.
    const allowed = new Set([
      'definitions.get',
      'definitions.getLifecycle',
      'definitions.list',
      'executors.has',
      'mapping.getRuleSet',
      'instructions.discover',
      'context.resolve',
      'work.get',
    ])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(allowed).toContain(call)
    }

    // Persistence is untouched: no runs, no waits, no graph state, no new
    // definition versions or snapshots were written.
    expect(await persistence.runs.list()).toHaveLength(0)
    expect(await persistence.waits.listOpen({})).toHaveLength(0)
    expect(
      await persistence.definitions.listVersions(DefinitionKind.Workflow, 'eval-flow'),
    ).toHaveLength(1)
  })
})
