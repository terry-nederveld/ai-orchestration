/**
 * Template catalog (mission §25): versioned templates using the same
 * workflow execution model, with declared capability requirements the
 * application validates before activation. Installation writes template
 * contents into the definition store (content-addressed versioning makes
 * reinstallation idempotent).
 */

import type {
  AgentProfileDefinition,
  DefinitionStore,
  EvaluationRubric,
  ExperimentDefinition,
} from '@overture/core'
import { DefinitionKind } from '@overture/core'
import {
  DELIVERY_DOD_NAME,
  DELIVERY_DOR_NAME,
  DELIVERY_WORKFLOW_NAME,
  deliveryDefinitionOfDone,
  deliveryDefinitionOfReady,
  deliveryWorkflow,
} from './delivery.js'
import {
  DISCOVERY_EXPERIMENT_NAME,
  DISCOVERY_RUBRIC_NAME,
  DISCOVERY_STORY_WORKFLOW_NAME,
  DISCOVERY_WORKFLOW_NAME,
  discoveryCreateStoryWorkflow,
  discoveryWorkflow,
} from './discovery.js'

export const discoveryRubric: EvaluationRubric = {
  name: DISCOVERY_RUBRIC_NAME,
  description: 'Scores discovery candidates on impact, confidence, and cost.',
  criteria: [
    { id: 'impact', description: 'Expected impact on the stated outcome.', weight: 4 },
    { id: 'confidence', description: 'Strength of supporting evidence.', weight: 3 },
    { id: 'effort', description: 'Inverse implementation cost (10 = trivial).', weight: 2 },
    { id: 'risk', description: 'Inverse risk (10 = very safe).', weight: 1 },
  ],
  killCriteria: [
    {
      id: 'no-evidence',
      description: 'The candidate has no supporting evidence at all.',
      expression: 'candidate.evidenceCount == 0',
    },
    {
      id: 'violates-constraints',
      description: 'The candidate conflicts with stated constraints of the outcome.',
    },
  ],
  advanceThreshold: 6,
}

export const discoveryExperiment: ExperimentDefinition = {
  name: DISCOVERY_EXPERIMENT_NAME,
  description: 'Generates and evaluates candidate approaches for a discovery hypothesis.',
  candidateCount: 3,
  generationStrategy:
    'Generate meaningfully different approaches: one minimal, one user-experience-first, one technically ambitious.',
  rubric: DISCOVERY_RUBRIC_NAME,
  prototype: true,
  survivorCount: 2,
  maxIterations: 3,
}

/**
 * Default profiles referenced by the flagship graphs. Operators fork or
 * compose these; the executor ids match the daemon's standard registrations
 * (CLI agent providers plus native-<provider> runtimes).
 */
export const deliveryDefaultProfile: AgentProfileDefinition = {
  name: 'delivery-default',
  description:
    'Coding profile for Autonomous Delivery: CLI coding agent first, native runtime fallback on provider outage.',
  fragment: {
    primary: { executor: 'claude-code' },
    fallback: { chain: [{ executor: 'native-anthropic' }], trigger: 'outage-only' },
    maxTurns: 80,
  },
}

export const discoveryDefaultProfile: AgentProfileDefinition = {
  name: 'discovery-default',
  description:
    'Research profile for Autonomous Discovery: native runtime first, CLI agent fallback on provider outage.',
  fragment: {
    primary: { executor: 'native-anthropic' },
    fallback: { chain: [{ executor: 'claude-code' }], trigger: 'outage-only' },
    maxTurns: 40,
  },
}

export interface TemplateDescriptor {
  readonly name: string
  readonly description: string
  /** Capabilities the runtime must provide before activation. */
  readonly requires: {
    readonly actions: readonly string[]
    readonly nodeKinds: readonly string[]
    readonly providerFeatures: readonly string[]
  }
  /** Definitions installed with the template. */
  readonly definitions: ReadonlyArray<{
    readonly kind: DefinitionKind
    readonly name: string
    readonly document: Readonly<Record<string, unknown>>
  }>
}

export const templates: readonly TemplateDescriptor[] = [
  {
    name: DELIVERY_WORKFLOW_NAME,
    description:
      'Autonomous Delivery: ranked backlog item to reviewed, gated, conventional-commit pull request.',
    requires: {
      actions: ['source_control.commit', 'source_control.pull_request', 'work.comment'],
      nodeKinds: ['agent', 'command', 'gate', 'action', 'terminal'],
      providerFeatures: ['scm.pull_request', 'workspace.git-worktree'],
    },
    definitions: [
      {
        kind: DefinitionKind.Workflow,
        name: DELIVERY_WORKFLOW_NAME,
        document: deliveryWorkflow as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.GateSet,
        name: DELIVERY_DOR_NAME,
        document: deliveryDefinitionOfReady as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.GateSet,
        name: DELIVERY_DOD_NAME,
        document: deliveryDefinitionOfDone as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.AgentProfile,
        name: deliveryDefaultProfile.name,
        document: deliveryDefaultProfile as unknown as Record<string, unknown>,
      },
    ],
  },
  {
    name: DISCOVERY_WORKFLOW_NAME,
    description:
      'Autonomous Discovery: outcome to experiment-validated PRD and, after approval, agent-ready stories.',
    requires: {
      actions: ['work.update_section', 'work.create_item', 'work.comment'],
      nodeKinds: ['agent', 'experiment', 'human-input', 'fan-out', 'action', 'terminal'],
      providerFeatures: ['work.body-update', 'work.create'],
    },
    definitions: [
      {
        kind: DefinitionKind.Workflow,
        name: DISCOVERY_WORKFLOW_NAME,
        document: discoveryWorkflow as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.Workflow,
        name: DISCOVERY_STORY_WORKFLOW_NAME,
        document: discoveryCreateStoryWorkflow as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.Rubric,
        name: DISCOVERY_RUBRIC_NAME,
        document: discoveryRubric as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.Experiment,
        name: DISCOVERY_EXPERIMENT_NAME,
        document: discoveryExperiment as unknown as Record<string, unknown>,
      },
      {
        kind: DefinitionKind.AgentProfile,
        name: discoveryDefaultProfile.name,
        document: discoveryDefaultProfile as unknown as Record<string, unknown>,
      },
    ],
  },
]

export interface AvailableCapabilities {
  readonly actions: readonly string[]
  readonly nodeKinds: readonly string[]
  readonly providerFeatures: readonly string[]
}

export interface CompatibilityReport {
  readonly compatible: boolean
  readonly missing: readonly string[]
}

export function validateCompatibility(
  template: TemplateDescriptor,
  available: AvailableCapabilities,
): CompatibilityReport {
  const missing: string[] = []
  for (const action of template.requires.actions) {
    if (!available.actions.includes(action)) missing.push(`action:${action}`)
  }
  for (const kind of template.requires.nodeKinds) {
    if (!available.nodeKinds.includes(kind)) missing.push(`node-kind:${kind}`)
  }
  for (const feature of template.requires.providerFeatures) {
    if (!available.providerFeatures.includes(feature)) missing.push(`provider:${feature}`)
  }
  return { compatible: missing.length === 0, missing }
}

/**
 * Install templates into the definition store. A definition that already
 * exists is left untouched — an operator's in-place edits (or an earlier
 * install) are never superseded by a boot-time reinstall; fork a template
 * under your own name for divergent workflows, or pass `refresh: true` to
 * deliberately mint pristine template versions over existing ones
 * (history is preserved either way — versions are append-only). Newly
 * created definitions start DRAFT unless `enable` is set.
 */
export async function installTemplates(
  store: DefinitionStore,
  options: {
    readonly enable?: boolean
    readonly only?: readonly string[]
    readonly refresh?: boolean
  } = {},
): Promise<ReadonlyArray<{ name: string; kind: DefinitionKind; version: number }>> {
  const installed: Array<{ name: string; kind: DefinitionKind; version: number }> = []
  for (const template of templates) {
    if (options.only && !options.only.includes(template.name)) continue
    for (const definition of template.definitions) {
      const existing = await store.get(definition.kind, definition.name)
      if (existing && !options.refresh) continue
      const saved = await store.save(definition.kind, definition.name, definition.document)
      if (options.enable) {
        await store.setLifecycle(definition.kind, definition.name, 'enabled')
      }
      installed.push({ name: saved.name, kind: saved.kind, version: saved.version })
    }
  }
  return installed
}
