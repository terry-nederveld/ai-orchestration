/**
 * Path safety for filesystem paths built from caller-controlled values
 * (run ids, branch names). Every value that becomes part of a path is
 * collapsed into a safe slug before joining, so `..`, path separators, and
 * other traversal tricks can never escape the configured root.
 */

import { resolve, sep } from 'node:path'
import { OrchestratorError } from '@overture/core'

const UNSAFE_CHARS = /[^a-zA-Z0-9._-]/g

/** Collapses a raw identifier into a filesystem-safe path segment. */
export function toSafeSlug(value: string): string {
  const replaced = value.replace(UNSAFE_CHARS, '-')
  const collapsed = replaced.replace(/-{2,}/g, '-')
  const trimmed = collapsed.replace(/^[.-]+|[.-]+$/g, '')
  if (trimmed.length === 0) {
    throw new OrchestratorError(
      `Cannot derive a safe path segment from "${value}"`,
      'invalid-input',
    )
  }
  return trimmed
}

/**
 * Joins `root` with safe-sluggified `segments`, refusing to produce a path
 * that escapes `root`.
 */
export function resolveInsideRoot(root: string, ...segments: string[]): string {
  const safeSegments = segments.map(toSafeSlug)
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...safeSegments)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new OrchestratorError(`Path "${target}" escapes root "${resolvedRoot}"`, 'policy')
  }
  return target
}
