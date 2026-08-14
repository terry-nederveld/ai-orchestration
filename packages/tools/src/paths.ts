/**
 * Path containment for filesystem tools. Every path an agent supplies is
 * resolved against the workspace root and must stay inside it; escapes are
 * rejected before any filesystem access happens.
 */

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
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

/**
 * Resolve a user-supplied path inside the workspace root, or throw. The
 * check is repeated against the real (symlink-resolved) path of the deepest
 * existing ancestor so a workspace-internal symlink cannot escape the root.
 */
export function containedPath(root: string, requested: string): string {
  const resolved = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  const normalizedRoot = resolve(root)
  const inside = (candidate: string, base: string) =>
    candidate === base || candidate.startsWith(base + sep)
  if (!inside(resolved, normalizedRoot)) {
    throw new PathEscapeError(requested)
  }
  const realRoot = safeRealpath(normalizedRoot) ?? normalizedRoot
  const realTarget = realpathOfDeepestExisting(resolved)
  if (realTarget !== undefined && !inside(realTarget, realRoot)) {
    throw new PathEscapeError(requested)
  }
  return resolved
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/** Realpath of `path`, or of its closest existing ancestor plus the rest. */
function realpathOfDeepestExisting(path: string): string | undefined {
  let current = path
  let suffix = ''
  for (let depth = 0; depth < 64; depth += 1) {
    const real = safeRealpath(current)
    if (real !== undefined) return suffix ? resolve(real, suffix) : real
    const parent = dirname(current)
    if (parent === current) return undefined
    suffix = suffix
      ? `${current.slice(parent.length + 1)}${sep}${suffix}`
      : current.slice(parent.length + 1)
    current = parent
  }
  return undefined
}
