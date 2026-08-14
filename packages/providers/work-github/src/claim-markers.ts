/**
 * Comment-based claim markers.
 *
 * GitHub Issues has a real label we can use as the primary "is this claimed"
 * signal (see issues-provider.ts), but knowing *who* holds the claim — needed
 * for idempotent re-claims by the same claimant vs. rejecting a competing one
 * — isn't something a label can carry by itself. GitHub Projects v2 items
 * back onto issues too, but claim state there is GraphQL-only and label
 * mutations need a label id we're not allowed to create on the fly.
 *
 * Both providers solve this the same way: append an HTML-comment marker to
 * an issue comment recording the claimant and run id, and read the most
 * recent marker back to determine current ownership.
 */

export interface ClaimMarker {
  readonly kind: 'claim' | 'release'
  readonly claimant: string
  readonly runId: string
}

const MARKER_PATTERN = /<!--\s*overture:(claim|release)\s+claimant=(\S+)\s+runId=(\S+)\s*-->/

export function formatClaimMarker(
  kind: 'claim' | 'release',
  claimant: string,
  runId: string,
): string {
  const marker = `<!-- overture:${kind} claimant=${claimant} runId=${runId} -->`
  return kind === 'claim'
    ? `${marker}\nClaimed by ${claimant} (run ${runId}).`
    : `${marker}\nReleased by ${claimant} (run ${runId}).`
}

export function parseClaimMarker(body: string): ClaimMarker | undefined {
  const match = MARKER_PATTERN.exec(body)
  if (!match) return undefined
  const kind = match[1]
  const claimant = match[2]
  const runId = match[3]
  if ((kind !== 'claim' && kind !== 'release') || !claimant || !runId) return undefined
  return { kind, claimant, runId }
}

/** Scans comment bodies (oldest -> newest) and returns the most recent claim/release marker, if any. */
export function findLatestClaimMarker(commentBodies: readonly string[]): ClaimMarker | undefined {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const marker = parseClaimMarker(commentBodies[i] ?? '')
    if (marker) return marker
  }
  return undefined
}
