/**
 * Path containment for filesystem tools. Every path an agent supplies is
 * resolved against the workspace root and must stay inside it; escapes are
 * rejected before any filesystem access happens.
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { ToolExecutionContext } from '@overture/core'

export class PathEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`path escapes the workspace: ${requested}`)
    this.name = 'PathEscapeError'
  }
}

export function workspaceRoot(context: ToolExecutionContext): string {
  const root = context.workspace?.path
  if (!root) throw new Error('this tool requires a workspace')
  return root
}

/** Resolve a user-supplied path inside the workspace root, or throw. */
export function containedPath(root: string, requested: string): string {
  const resolved = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  const normalizedRoot = resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new PathEscapeError(requested)
  }
  return resolved
}
