/**
 * Attribution policy: Overture-authored commits and pull requests must never
 * carry AI/tool attribution trailers or watermarks. Enforced at the boundary
 * (commit, PR creation) rather than trusted to callers.
 */

import { OrchestratorError } from '@overture/core'

const ATTRIBUTION_TRAILER_PATTERN =
  /^(Co-authored-by|Generated-by|Generated-with|Assisted-by|AI-generated):/im

/** Matches "Generated with [Claude Code]" style watermarks in PR/commit bodies. */
const WATERMARK_PATTERN = /generated\s+with\s+\[?claude/i

export function assertNoAttributionTrailers(message: string): void {
  if (ATTRIBUTION_TRAILER_PATTERN.test(message)) {
    throw new OrchestratorError(
      'Commit message contains a disallowed attribution trailer',
      'policy',
    )
  }
}

/** Same check as assertNoAttributionTrailers, but reports the offending subject line. */
export function assertNoAttributionTrailersInPushedCommit(message: string): void {
  if (ATTRIBUTION_TRAILER_PATTERN.test(message)) {
    const subject = message.split('\n')[0]?.trim() || '(empty subject)'
    throw new OrchestratorError(
      `Refusing to push: commit "${subject}" contains a disallowed attribution trailer`,
      'policy',
    )
  }
}

export function assertNoAttributionContent(text: string, context: string): void {
  if (ATTRIBUTION_TRAILER_PATTERN.test(text) || WATERMARK_PATTERN.test(text)) {
    throw new OrchestratorError(
      `${context} contains disallowed attribution or watermark content`,
      'policy',
    )
  }
}
