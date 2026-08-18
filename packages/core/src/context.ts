/**
 * Composable context resolution (mission §10): resolvers contribute typed
 * fragments (work-item content, relationships, instructions, ADRs,
 * workflow outputs, documents, tool evidence) assembled under an explicit
 * budget. Traversal defaults to 1-up/1-down plus direct blockers and
 * dependencies; attachments are opt-in.
 */

import type { RunId } from './ids.js'
import type { WorkItem } from './work.js'

export interface ContextFragment {
  readonly resolverId: string
  /** e.g. 'work-item', 'parent', 'instructions', 'adr', 'attachment'. */
  readonly kind: string
  readonly title: string
  readonly content: string
  /** Higher survives budget pressure longer. */
  readonly priority: number
  readonly provenance: string
}

export interface TraversalPolicy {
  readonly parentLevels: number
  readonly childLevels: number
  readonly includeBlockers: boolean
  readonly includeDependencies: boolean
  readonly includeRelated: boolean
}

export const defaultTraversalPolicy: TraversalPolicy = {
  parentLevels: 1,
  childLevels: 1,
  includeBlockers: true,
  includeDependencies: true,
  includeRelated: false,
}

export interface AttachmentPolicy {
  readonly enabled: boolean
  readonly allowedTypes: readonly string[]
  readonly maxBytesPerAttachment: number
  readonly maxAttachments: number
  readonly maxExtractedChars: number
}

export const defaultAttachmentPolicy: AttachmentPolicy = {
  enabled: false,
  allowedTypes: ['text/plain', 'text/markdown'],
  maxBytesPerAttachment: 1024 * 1024,
  maxAttachments: 5,
  maxExtractedChars: 20_000,
}

export interface ContextRequest {
  readonly runId: RunId
  readonly item: WorkItem
  readonly traversal: TraversalPolicy
  readonly attachments: AttachmentPolicy
  /** Character budget for the assembled bundle. */
  readonly maxTotalChars: number
}

export interface ContextResolver {
  readonly id: string
  resolve(request: ContextRequest): Promise<readonly ContextFragment[]>
}

export interface ContextBundle {
  readonly fragments: readonly ContextFragment[]
  readonly excluded: ReadonlyArray<{
    readonly fragment: ContextFragment
    readonly reason: string
  }>
  readonly totalChars: number
}

/**
 * Assemble fragments under budget: sort by priority desc (ties by resolver
 * order), include until the budget is exhausted, record exclusions.
 */
export function assembleContext(
  fragments: readonly ContextFragment[],
  maxTotalChars: number,
): ContextBundle {
  const ordered = fragments
    .map((fragment, index) => ({ fragment, index }))
    .sort((a, b) => b.fragment.priority - a.fragment.priority || a.index - b.index)

  const included: ContextFragment[] = []
  const excluded: Array<{ fragment: ContextFragment; reason: string }> = []
  let total = 0
  for (const { fragment } of ordered) {
    if (total + fragment.content.length > maxTotalChars) {
      excluded.push({ fragment, reason: 'context budget exceeded' })
      continue
    }
    included.push(fragment)
    total += fragment.content.length
  }
  return { fragments: included, excluded, totalChars: total }
}

/** Render a bundle for agent consumption, framing external content. */
export function renderContext(bundle: ContextBundle): string {
  return bundle.fragments
    .map(
      (fragment) =>
        `--- ${fragment.title} (${fragment.kind}; source: ${fragment.provenance}) ---\n${fragment.content.trim()}`,
    )
    .join('\n\n')
}
