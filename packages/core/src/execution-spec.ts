/**
 * ExecutionSpecification (ADR pending in this phase; mission §7): the
 * immutable, revisioned statement of what a run is doing and under what
 * conditions. Resume preserves history, reconciles authoritative external
 * changes, and creates revision N+1 when anything material changed.
 * Provider session continuation is an optimization, never a correctness
 * dependency.
 */

import type { RunId } from './ids.js'
import type { RepositoryReference } from './work.js'

export type RepositoryRole = 'primary' | 'frontend' | 'backend' | 'infra' | 'docs' | 'dependency'

export interface SpecRepository {
  readonly repository: RepositoryReference
  readonly role: RepositoryRole
  /** How this mapping was determined (rule id, explicit, agent). */
  readonly resolvedBy: string
}

export interface SpecInstruction {
  /** e.g. 'CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'. */
  readonly source: string
  readonly scope: 'global' | 'repository' | 'directory'
  readonly path: string
  readonly contentHash: string
  /** Whether the document was actually included in agent context. */
  readonly applied: boolean
}

export interface ExecutionSpecification {
  readonly runId: RunId
  /** 1-based; revisions are append-only. */
  readonly revision: number
  readonly createdAt: Date
  /** Why this revision exists ('initial', 'resume-reconciliation', …). */
  readonly reason: string
  readonly goal: string
  readonly acceptanceCriteria: readonly string[]
  readonly workItemId: string
  readonly relatedWorkItemIds: readonly string[]
  readonly repositories: readonly SpecRepository[]
  readonly instructions: readonly SpecInstruction[]
  /** Promoted supplemental human context (explicit promotions only). */
  readonly promotedContext: readonly string[]
  /** Snapshot + profile references pinning behavior. */
  readonly snapshotId: string
  readonly profileName?: string
  readonly completionCriteria: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface ExecutionSpecRepository {
  save(spec: ExecutionSpecification): Promise<void>
  get(runId: RunId, revision: number): Promise<ExecutionSpecification | undefined>
  latest(runId: RunId): Promise<ExecutionSpecification | undefined>
  listRevisions(runId: RunId): Promise<readonly ExecutionSpecification[]>
}

/**
 * Compare two specs for material difference (everything except revision
 * bookkeeping); used on resume to decide whether revision N+1 is needed.
 */
export function specsMateriallyDiffer(
  a: ExecutionSpecification,
  b: ExecutionSpecification,
): boolean {
  const material = (spec: ExecutionSpecification) =>
    JSON.stringify({
      goal: spec.goal,
      acceptanceCriteria: spec.acceptanceCriteria,
      workItemId: spec.workItemId,
      related: spec.relatedWorkItemIds,
      repositories: spec.repositories,
      instructions: spec.instructions.map((instruction) => ({
        path: instruction.path,
        hash: instruction.contentHash,
        applied: instruction.applied,
      })),
      promoted: spec.promotedContext,
      snapshot: spec.snapshotId,
      profile: spec.profileName,
      completion: spec.completionCriteria,
    })
  return material(a) !== material(b)
}
