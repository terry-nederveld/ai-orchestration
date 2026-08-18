/**
 * DefaultSpecBuilder: assembles an ExecutionSpecification revision from
 * authoritative sources — the work item, declarative repository-mapping
 * rules, and instruction discovery over the run's workspace. Everything the
 * agent will act under is recorded with provenance (`resolvedBy`, provider
 * ids), so a later revision can show exactly what changed and why.
 */

import type {
  Clock,
  ExecutionSpecification,
  InstructionProvider,
  MappingRuleSet,
  SpecInstruction,
  SpecRepository,
  WorkItem,
} from '@overture/core'
import { mergeInstructions, resolveRepositories } from '@overture/core'
import type { SpecBuilder } from './coordinator.js'

export interface DefaultSpecBuilderOptions {
  readonly clock: Clock
  /** Declarative work-item → repository rules; explicit item metadata wins. */
  readonly mapping?: MappingRuleSet
  /** Convention discovery (CLAUDE.md, AGENTS.md, …) over the workspace. */
  readonly instructions?: readonly InstructionProvider[]
  /** Character budget across applied instruction documents. */
  readonly instructionBudgetChars?: number
  readonly defaultProfileName?: string
}

export class DefaultSpecBuilder implements SpecBuilder {
  constructor(private readonly options: DefaultSpecBuilderOptions) {}

  async build(input: {
    readonly runId: import('@overture/core').RunId
    readonly item: WorkItem
    readonly snapshotId: string
    readonly revision: number
    readonly reason: string
    readonly workspacePath?: string
  }): Promise<ExecutionSpecification> {
    const { item } = input
    const repositories = this.resolveRepositories(item)
    const instructions = await this.discoverInstructions(input.workspacePath)
    const acceptanceCriteria = extractChecklist(item.description ?? '')

    return {
      runId: input.runId,
      revision: input.revision,
      createdAt: this.options.clock.now(),
      reason: input.reason,
      goal: item.description ? `${item.title}\n\n${item.description}` : item.title,
      acceptanceCriteria,
      workItemId: String(item.id),
      relatedWorkItemIds: item.relationships.map((relationship) => relationship.targetExternalId),
      repositories,
      instructions,
      promotedContext: [],
      snapshotId: input.snapshotId,
      ...(this.options.defaultProfileName !== undefined
        ? { profileName: this.options.defaultProfileName }
        : {}),
      completionCriteria: acceptanceCriteria,
      metadata: {
        provider: item.provider,
        externalId: item.externalId,
        ...(item.url !== undefined ? { url: item.url } : {}),
      },
    }
  }

  private resolveRepositories(item: WorkItem): readonly SpecRepository[] {
    const resolved: SpecRepository[] = []
    // Explicit item metadata is the highest-precedence resolution path.
    if (item.repository) {
      resolved.push({ repository: item.repository, role: 'primary', resolvedBy: 'explicit' })
    }
    if (this.options.mapping) {
      for (const entry of resolveRepositories(this.options.mapping, item)) {
        const duplicate = resolved.some(
          (existing) =>
            existing.repository.locator === entry.repository.locator &&
            existing.role === entry.role,
        )
        if (!duplicate) resolved.push(entry)
      }
    }
    return resolved
  }

  private async discoverInstructions(
    workspacePath: string | undefined,
  ): Promise<readonly SpecInstruction[]> {
    if (!workspacePath || !this.options.instructions?.length) return []
    const discovered = (
      await Promise.all(
        this.options.instructions.map((provider) =>
          provider.discover({ repositoryPaths: [workspacePath] }).catch(() => []),
        ),
      )
    ).flat()
    const effective = mergeInstructions(discovered, {
      ...(this.options.instructionBudgetChars !== undefined
        ? { maxTotalChars: this.options.instructionBudgetChars }
        : {}),
    })
    return [
      ...effective.documents.map((document) => toSpecInstruction(document, true)),
      ...effective.excluded.map(({ document }) => toSpecInstruction(document, false)),
    ]
  }
}

function toSpecInstruction(
  document: import('@overture/core').InstructionDocument,
  applied: boolean,
): SpecInstruction {
  return {
    source: document.source,
    scope: document.scope,
    path: document.path,
    contentHash: document.contentHash,
    applied,
  }
}

/** Markdown task-list items (`- [ ] …`) become acceptance criteria. */
export function extractChecklist(description: string): readonly string[] {
  const criteria: string[] = []
  for (const line of description.split('\n')) {
    const match = /^\s*[-*]\s*\[[ xX]\]\s+(.+)$/.exec(line)
    if (match?.[1]) criteria.push(match[1].trim())
  }
  return criteria
}
