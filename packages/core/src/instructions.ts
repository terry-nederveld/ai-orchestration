/**
 * Instruction discovery (mission §9): composable providers find applicable
 * convention files (CLAUDE.md, AGENTS.md, AGENT.md, copilot-instructions,
 * provider-specific formats) with scope, precedence, and provenance. What
 * was actually applied is recorded in the execution specification.
 */

export interface InstructionDocument {
  /** Convention identifier, e.g. 'CLAUDE.md', 'AGENTS.md'. */
  readonly source: string
  readonly scope: 'global' | 'repository' | 'directory'
  /** Absolute path the document was read from. */
  readonly path: string
  /** Path relative to its repository root, when repository-scoped. */
  readonly relativePath?: string
  readonly content: string
  readonly contentHash: string
  /**
   * Precedence weight: higher wins on conflicting guidance; directory
   * scope defaults above repository scope, repository above global.
   */
  readonly precedence: number
  /** Which provider discovered it. */
  readonly providerId: string
}

export interface InstructionDiscoveryRequest {
  /** Repository working directories to scan. */
  readonly repositoryPaths: readonly string[]
  /** Directories (relative to each repository) the work touches, if known. */
  readonly focusDirectories?: readonly string[]
}

export interface InstructionProvider {
  readonly id: string
  discover(request: InstructionDiscoveryRequest): Promise<readonly InstructionDocument[]>
}

export interface EffectiveInstructions {
  /** Ordered by ascending precedence (render order). */
  readonly documents: readonly InstructionDocument[]
  /** Documents discovered but excluded (budget, duplicates) with reasons. */
  readonly excluded: ReadonlyArray<{
    readonly document: InstructionDocument
    readonly reason: string
  }>
}

/**
 * Merge provider results: dedupe by path (highest precedence wins), order
 * ascending by precedence, and enforce a character budget by dropping the
 * lowest-precedence documents first.
 */
export function mergeInstructions(
  discovered: readonly InstructionDocument[],
  options: { readonly maxTotalChars?: number } = {},
): EffectiveInstructions {
  const byPath = new Map<string, InstructionDocument>()
  for (const document of discovered) {
    const existing = byPath.get(document.path)
    if (!existing || document.precedence > existing.precedence) {
      byPath.set(document.path, document)
    }
  }
  const ordered = [...byPath.values()].sort((a, b) => a.precedence - b.precedence)

  const budget = options.maxTotalChars ?? 60_000
  const excluded: Array<{ document: InstructionDocument; reason: string }> = []
  // Drop lowest-precedence first until within budget.
  const kept = [...ordered]
  let total = kept.reduce((sum, document) => sum + document.content.length, 0)
  while (total > budget && kept.length > 1) {
    const dropped = kept.shift()
    if (!dropped) break
    excluded.push({ document: dropped, reason: 'instruction budget exceeded' })
    total -= dropped.content.length
  }
  return { documents: kept, excluded }
}

/** Render effective instructions for inclusion in agent context. */
export function renderInstructions(effective: EffectiveInstructions): string {
  return effective.documents
    .map(
      (document) =>
        `--- Instructions from ${document.relativePath ?? document.path} (${document.source}) ---\n${document.content.trim()}`,
    )
    .join('\n\n')
}
