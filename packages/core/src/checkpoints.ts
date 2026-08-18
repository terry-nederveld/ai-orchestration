/**
 * Durable checkpoints (mission §6): model sessions are disposable; the
 * durable work product is domain-appropriate. Coding runs checkpoint to a
 * remote git branch; ideation/requirements runs checkpoint into a managed
 * section of the originating work item. Strategies are ports so new
 * domains can add their own.
 */

import type { RunId } from './ids.js'

export interface Checkpoint {
  readonly id: string
  readonly runId: RunId
  readonly nodeId: string
  readonly strategy: string
  readonly createdAt: Date
  /** Strategy-specific durable coordinates (branch+sha, section hash…). */
  readonly coordinates: Readonly<Record<string, unknown>>
  readonly summary: string
  readonly specRevision: number
}

export interface CheckpointContext {
  readonly runId: RunId
  readonly nodeId: string
  readonly specRevision: number
  /** Coding runs: absolute workspace path. */
  readonly workspacePath?: string
  /** Coding runs: the run's durable remote branch. */
  readonly branch?: string
  /** Non-code runs: the originating work item id. */
  readonly workItemId?: string
  readonly summary: string
}

/**
 * A checkpoint strategy persists meaningful progress durably and can
 * restore enough state for a fresh session to continue.
 */
export interface CheckpointStrategy {
  readonly id: string
  /** Persist progress; returns durable coordinates. */
  checkpoint(context: CheckpointContext): Promise<Checkpoint>
  /**
   * Recreate local working state from durable coordinates (e.g. fresh
   * worktree from the remote branch). Returns strategy-specific handle
   * data (such as the restored workspace path).
   */
  restore(checkpoint: Checkpoint): Promise<Readonly<Record<string, unknown>>>
}

export interface CheckpointRepository {
  save(checkpoint: Checkpoint): Promise<void>
  latestForRun(runId: RunId): Promise<Checkpoint | undefined>
  listForRun(runId: RunId): Promise<readonly Checkpoint[]>
}

// ---------------------------------------------------------------------------
// Managed work-item section (non-code durable product).
// ---------------------------------------------------------------------------

export const MANAGED_SECTION_BEGIN = '<!-- overture:managed:begin -->'
export const MANAGED_SECTION_END = '<!-- overture:managed:end -->'

/**
 * Replace (or append) the managed section of a work-item body, preserving
 * every character of human content outside the delimiters. A body whose
 * delimiters were tampered with (one marker missing) is left untouched
 * and reported, never overwritten.
 */
export function upsertManagedSection(
  body: string,
  managedContent: string,
): { readonly body: string; readonly applied: boolean; readonly reason?: string } {
  const section = `${MANAGED_SECTION_BEGIN}\n${managedContent.trim()}\n${MANAGED_SECTION_END}`
  const begin = body.indexOf(MANAGED_SECTION_BEGIN)
  const end = body.indexOf(MANAGED_SECTION_END)

  if (begin === -1 && end === -1) {
    const separator = body.trim().length > 0 ? '\n\n' : ''
    return { body: `${body}${separator}${section}`, applied: true }
  }
  if (begin === -1 || end === -1 || end < begin) {
    return {
      body,
      applied: false,
      reason: 'managed-section delimiters are damaged; refusing to modify the body',
    }
  }
  const before = body.slice(0, begin)
  const after = body.slice(end + MANAGED_SECTION_END.length)
  return { body: `${before}${section}${after}`, applied: true }
}

/** Extract the current managed content, if present and intact. */
export function readManagedSection(body: string): string | undefined {
  const begin = body.indexOf(MANAGED_SECTION_BEGIN)
  const end = body.indexOf(MANAGED_SECTION_END)
  if (begin === -1 || end === -1 || end < begin) return undefined
  return body.slice(begin + MANAGED_SECTION_BEGIN.length, end).trim()
}
