import { DefinitionKind, validateGraph } from '@overture/core'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { describe, expect, it } from 'vitest'
import { installTemplates, templates, validateCompatibility } from './catalog.js'
import { deliveryWorkflow } from './delivery.js'
import { discoveryCreateStoryWorkflow, discoveryWorkflow } from './discovery.js'

describe('flagship templates', () => {
  it('delivery workflow graph validates', () => {
    expect(validateGraph(deliveryWorkflow)).toEqual([])
  })

  it('discovery workflow graphs validate', () => {
    expect(validateGraph(discoveryWorkflow)).toEqual([])
    expect(validateGraph(discoveryCreateStoryWorkflow)).toEqual([])
  })

  it('delivery covers the mission lifecycle: gates, review loop, delivery', () => {
    const nodeIds = deliveryWorkflow.nodes.map((node) => node.id)
    for (const required of [
      'dor',
      'plan',
      'implement',
      'test',
      'review',
      'remediate',
      'dod',
      'commit',
      'deliver',
    ]) {
      expect(nodeIds).toContain(required)
    }
    // The remediation loop is bounded.
    const loop = deliveryWorkflow.transitions.find((t) => t.id === 'review-remediate')
    expect(loop?.loopBound).toBeDefined()
  })

  it('discovery covers experiment, PRD capture, approval, and story fan-out', () => {
    const nodeIds = discoveryWorkflow.nodes.map((node) => node.id)
    for (const required of [
      'investigate',
      'hypothesize',
      'experiment',
      'prd',
      'capture_prd',
      'approval',
      'create_stories',
    ]) {
      expect(nodeIds).toContain(required)
    }
    // Killed experiments conclude the workflow as a successful kill.
    const killedPath = discoveryWorkflow.transitions.find((t) => t.id === 'exp-killed')
    expect(killedPath?.to).toBe('killed')
    // stop_after=prd stops before story creation.
    const stop = discoveryWorkflow.transitions.find((t) => t.id === 'capture-stop')
    expect(stop?.condition).toContain('stop_after')
  })

  it('installs templates idempotently through content addressing', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const first = await installTemplates(persistence.definitions, { enable: true })
    expect(first.length).toBeGreaterThan(0)
    expect(first.every((entry) => entry.version === 1)).toBe(true)

    const second = await installTemplates(persistence.definitions)
    expect(second.every((entry) => entry.version === 1)).toBe(true)

    const workflow = await persistence.definitions.get(
      DefinitionKind.Workflow,
      'autonomous-delivery',
    )
    expect(workflow?.version).toBe(1)
    expect(
      await persistence.definitions.getLifecycle(DefinitionKind.Workflow, 'autonomous-delivery'),
    ).toBe('enabled')
  })

  it('validates template compatibility against available capabilities', () => {
    const delivery = templates.find((template) => template.name === 'autonomous-delivery')
    if (!delivery) throw new Error('missing template')
    const compatible = validateCompatibility(delivery, {
      actions: ['source_control.commit', 'source_control.pull_request', 'work.comment'],
      nodeKinds: ['agent', 'command', 'gate', 'action', 'terminal'],
      providerFeatures: ['scm.pull_request', 'workspace.git-worktree'],
    })
    expect(compatible.compatible).toBe(true)

    const incompatible = validateCompatibility(delivery, {
      actions: [],
      nodeKinds: ['agent'],
      providerFeatures: [],
    })
    expect(incompatible.compatible).toBe(false)
    expect(incompatible.missing).toContain('action:source_control.commit')
  })
})
