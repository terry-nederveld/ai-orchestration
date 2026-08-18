/**
 * Snapshot resolution (ADR-0018): walk a workflow graph, collect every
 * definition it references (sub-workflows recursively, gate sets, rubrics,
 * experiments, agent profiles and their composition fragments), and pin
 * exact versions into one immutable ResolvedSnapshot.
 */

import type {
  AgentProfileDefinition,
  DefinitionRef,
  DefinitionStore,
  DefinitionVersion,
  IdGenerator,
  ResolvedSnapshot,
  WorkflowGraph,
} from '@overture/core'
import { DefinitionKind, OrchestratorError, validateGraph } from '@overture/core'

export class SnapshotResolver {
  constructor(
    private readonly store: DefinitionStore,
    private readonly ids: IdGenerator,
  ) {}

  async resolve(rootWorkflowName: string, rootVersion?: number): Promise<ResolvedSnapshot> {
    const collected = new Map<string, DefinitionVersion>()
    const root = await this.require(DefinitionKind.Workflow, rootWorkflowName, rootVersion)
    await this.collectWorkflow(root, collected)

    return {
      id: this.ids.next('snapshot'),
      root: { name: root.name, version: root.version },
      definitions: [...collected.values()],
      createdAt: new Date(),
    }
  }

  private key(definition: DefinitionVersion): string {
    return `${definition.kind}:${definition.name}`
  }

  private async require(
    kind: DefinitionKind,
    name: string,
    version?: number,
  ): Promise<DefinitionVersion> {
    const definition = await this.store.get(kind, name, version)
    if (!definition) {
      throw new OrchestratorError(
        `definition not found: ${kind} '${name}'${version !== undefined ? `@${version}` : ''}`,
        'invalid-input',
      )
    }
    if (version === undefined) {
      const lifecycle = await this.store.getLifecycle(kind, name)
      if (lifecycle !== 'enabled') {
        throw new OrchestratorError(
          `definition ${kind} '${name}' is ${lifecycle}; only enabled definitions start new runs`,
          'policy',
        )
      }
    }
    return definition
  }

  private async collect(
    kind: DefinitionKind,
    ref: DefinitionRef,
    collected: Map<string, DefinitionVersion>,
  ): Promise<DefinitionVersion> {
    const existing = collected.get(`${kind}:${ref.name}`)
    if (existing) return existing
    const definition = await this.require(kind, ref.name, ref.version)
    collected.set(this.key(definition), definition)
    return definition
  }

  private async collectWorkflow(
    definition: DefinitionVersion,
    collected: Map<string, DefinitionVersion>,
  ): Promise<void> {
    if (collected.has(this.key(definition))) return
    collected.set(this.key(definition), definition)

    const graph = definition.document as unknown as WorkflowGraph
    const issues = validateGraph(graph)
    if (issues.length > 0) {
      throw new OrchestratorError(
        `workflow '${definition.name}'@${definition.version} is invalid: ${issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
        'invalid-input',
      )
    }

    if (graph.defaultProfile) {
      await this.collectProfile(graph.defaultProfile, collected)
    }
    for (const node of graph.nodes) {
      const config = node.config
      switch (config.kind) {
        case 'agent':
          if (config.profile) await this.collectProfile(config.profile, collected)
          break
        case 'gate': {
          await this.collect(DefinitionKind.GateSet, config.gateSet, collected)
          if (config.remediationProfile) {
            await this.collectProfile(config.remediationProfile, collected)
          }
          break
        }
        case 'experiment': {
          const experiment = await this.collect(
            DefinitionKind.Experiment,
            config.experiment,
            collected,
          )
          const rubricRef =
            config.rubric ??
            ({ name: (experiment.document as { rubric?: string }).rubric ?? '' } as DefinitionRef)
          if (rubricRef.name) {
            await this.collect(DefinitionKind.Rubric, rubricRef, collected)
          }
          break
        }
        case 'subworkflow': {
          const child = await this.require(
            DefinitionKind.Workflow,
            config.workflow.name,
            config.workflow.version,
          )
          await this.collectWorkflow(child, collected)
          break
        }
        case 'fan-out': {
          const child = await this.require(
            DefinitionKind.Workflow,
            config.workflow.name,
            config.workflow.version,
          )
          await this.collectWorkflow(child, collected)
          break
        }
        default:
          break
      }
    }
  }

  /** Profiles compose from fragments; collect the whole closure. */
  private async collectProfile(
    ref: DefinitionRef,
    collected: Map<string, DefinitionVersion>,
    depth = 0,
  ): Promise<void> {
    if (depth > 10) {
      throw new OrchestratorError(
        `agent profile composition too deep at '${ref.name}'`,
        'invalid-input',
      )
    }
    if (collected.has(`${DefinitionKind.AgentProfile}:${ref.name}`)) return
    const definition = await this.collect(DefinitionKind.AgentProfile, ref, collected)
    const profile = definition.document as unknown as AgentProfileDefinition
    for (const fragmentName of profile.compose ?? []) {
      await this.collectProfile({ name: fragmentName }, collected, depth + 1)
    }
  }
}
