/**
 * Stock context resolvers (mission §10): work-item content, relationship
 * traversal, effective instructions, and opt-in attachments. Each resolver
 * contributes typed fragments; assembly under budget happens in resolve.ts.
 */

import type {
  ContextFragment,
  ContextRequest,
  ContextResolver,
  InstructionDocument,
  InstructionProvider,
  Logger,
  WorkItem,
  WorkProvider,
  WorkRelationshipKind,
} from '@overture/core'
import { mergeInstructions, noopLogger, renderInstructions } from '@overture/core'

const MAX_RELATION_FETCHES = 20
const MAX_RELATION_DESCRIPTION_CHARS = 2000

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`
}

function workItemProvenance(item: WorkItem): string {
  return `${item.provider} work item ${item.externalId}`
}

/** Fragments for the active work item: summary plus state/type/labels. */
export class WorkItemContextResolver implements ContextResolver {
  readonly id = 'work-item'

  async resolve(request: ContextRequest): Promise<readonly ContextFragment[]> {
    const item = request.item
    const summary: ContextFragment = {
      resolverId: this.id,
      kind: 'work-item',
      title: `Work item ${item.externalId}: ${item.title}`,
      content: item.description === undefined ? item.title : `${item.title}\n\n${item.description}`,
      priority: 100,
      provenance: workItemProvenance(item),
    }
    const detailLines = [
      `State: ${item.state}`,
      ...(item.type !== undefined ? [`Type: ${item.type}`] : []),
      ...(item.priority !== undefined ? [`Priority: ${item.priority}`] : []),
      ...(item.labels.length > 0 ? [`Labels: ${item.labels.join(', ')}`] : []),
    ]
    const details: ContextFragment = {
      resolverId: this.id,
      kind: 'work-item',
      title: `Work item ${item.externalId} metadata`,
      content: detailLines.join('\n'),
      priority: 90,
      provenance: workItemProvenance(item),
    }
    return [summary, details]
  }
}

export interface RelationshipContextResolverDeps {
  /** Looks up the WorkProvider that owns a given provider id. */
  readonly work: (providerId: string) => WorkProvider | undefined
  readonly logger?: Logger
}

interface DirectRelationSpec {
  readonly relationKind: WorkRelationshipKind
  readonly fragmentKind: string
  readonly label: string
  readonly priority: number
  readonly enabled: boolean
}

/**
 * Traverses the active item's relationship graph per the request's
 * TraversalPolicy. An item's 'child-of' relationships point at its parents
 * and 'parent-of' at its children; blockers come from 'blocked-by' targets
 * and dependencies from 'blocks' targets. Fetches are capped at 20 per
 * resolution; each referenced item is fetched at most once, keeping the
 * first role it was reached through (parents, children, blockers,
 * dependencies, related — in that order).
 */
export class RelationshipContextResolver implements ContextResolver {
  readonly id = 'relationships'
  private readonly logger: Logger

  constructor(private readonly deps: RelationshipContextResolverDeps) {
    this.logger = deps.logger ?? noopLogger
  }

  async resolve(request: ContextRequest): Promise<readonly ContextFragment[]> {
    const item = request.item
    const provider = this.deps.work(item.provider)
    if (!provider) {
      this.logger.warn('no work provider for relationship traversal', { provider: item.provider })
      return []
    }

    const fragments: ContextFragment[] = []
    const visited = new Set<string>([item.externalId])
    let fetches = 0

    const fetchItem = async (externalId: string): Promise<WorkItem | undefined> => {
      if (fetches >= MAX_RELATION_FETCHES) return undefined
      fetches += 1
      try {
        return await provider.get(externalId)
      } catch (error) {
        this.logger.warn('failed to fetch related work item', {
          externalId,
          error: error instanceof Error ? error.message : String(error),
        })
        return undefined
      }
    }

    const traverse = async (
      relationKind: WorkRelationshipKind,
      fragmentKind: string,
      label: string,
      priority: number,
      levels: number,
    ): Promise<void> => {
      let frontier: readonly WorkItem[] = [item]
      for (let level = 0; level < levels && frontier.length > 0; level += 1) {
        const next: WorkItem[] = []
        for (const current of frontier) {
          for (const relation of current.relationships) {
            if (relation.kind !== relationKind) continue
            if (visited.has(relation.targetExternalId)) continue
            visited.add(relation.targetExternalId)
            const related = await fetchItem(relation.targetExternalId)
            if (!related) continue
            fragments.push(this.relationFragment(fragmentKind, label, priority, related))
            next.push(related)
          }
        }
        frontier = next
      }
    }

    await traverse('child-of', 'parent', 'Parent', 70, request.traversal.parentLevels)
    await traverse('parent-of', 'child', 'Child', 60, request.traversal.childLevels)

    const direct: readonly DirectRelationSpec[] = [
      {
        relationKind: 'blocked-by',
        fragmentKind: 'blocker',
        label: 'Blocker',
        priority: 65,
        enabled: request.traversal.includeBlockers,
      },
      {
        relationKind: 'blocks',
        fragmentKind: 'dependency',
        label: 'Dependency',
        priority: 65,
        enabled: request.traversal.includeDependencies,
      },
      {
        relationKind: 'relates-to',
        fragmentKind: 'related',
        label: 'Related',
        priority: 40,
        enabled: request.traversal.includeRelated,
      },
    ]
    for (const spec of direct) {
      if (!spec.enabled) continue
      await traverse(spec.relationKind, spec.fragmentKind, spec.label, spec.priority, 1)
    }
    return fragments
  }

  private relationFragment(
    kind: string,
    label: string,
    priority: number,
    item: WorkItem,
  ): ContextFragment {
    const description =
      item.description === undefined
        ? undefined
        : truncate(item.description, MAX_RELATION_DESCRIPTION_CHARS)
    return {
      resolverId: this.id,
      kind,
      title: `${label} ${item.externalId}: ${item.title}`,
      content: description === undefined ? item.title : `${item.title}\n\n${description}`,
      priority,
      provenance: workItemProvenance(item),
    }
  }
}

export interface InstructionContextResolverDeps {
  readonly providers: readonly InstructionProvider[]
  /** Repository working directories to scan for instruction files. */
  readonly repositoryPaths: () => readonly string[]
  /** Directories (relative to each repository) the work touches, if known. */
  readonly focusDirectories?: () => readonly string[]
  readonly logger?: Logger
}

/**
 * Bridges instruction discovery into context: discovers via all providers,
 * merges with mergeInstructions, and emits a single 'instructions' fragment
 * containing the rendered effective instructions.
 */
export class InstructionContextResolver implements ContextResolver {
  readonly id = 'instructions'
  private readonly logger: Logger

  constructor(private readonly deps: InstructionContextResolverDeps) {
    this.logger = deps.logger ?? noopLogger
  }

  async resolve(_request: ContextRequest): Promise<readonly ContextFragment[]> {
    const focusDirectories = this.deps.focusDirectories?.()
    const discoveryRequest = {
      repositoryPaths: this.deps.repositoryPaths(),
      ...(focusDirectories !== undefined ? { focusDirectories } : {}),
    }
    const discovered: InstructionDocument[] = []
    for (const provider of this.deps.providers) {
      try {
        discovered.push(...(await provider.discover(discoveryRequest)))
      } catch (error) {
        this.logger.warn('instruction provider failed', {
          providerId: provider.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const effective = mergeInstructions(discovered)
    if (effective.documents.length === 0) return []
    return [
      {
        resolverId: this.id,
        kind: 'instructions',
        title: `Effective instructions (${effective.documents.length} documents)`,
        content: renderInstructions(effective),
        priority: 95,
        provenance: 'instruction-discovery',
      },
    ]
  }
}

/** A discovered attachment; text() extracts its content lazily. */
export interface AttachmentInput {
  readonly name: string
  readonly type: string
  readonly sizeBytes: number
  text(): Promise<string>
}

export type FetchAttachments = (item: WorkItem) => Promise<readonly AttachmentInput[]>

/** Work providers do not expose attachments yet; the port defaults to none. */
export const noopFetchAttachments: FetchAttachments = async () => []

export interface AttachmentContextResolverDeps {
  readonly fetchAttachments?: FetchAttachments
  readonly logger?: Logger
}

/**
 * Opt-in attachment content, gated by the request's AttachmentPolicy:
 * nothing unless enabled, then type/size filters, a count cap, and
 * per-attachment extraction truncation.
 */
export class AttachmentContextResolver implements ContextResolver {
  readonly id = 'attachments'
  private readonly fetchAttachments: FetchAttachments
  private readonly logger: Logger

  constructor(deps: AttachmentContextResolverDeps = {}) {
    this.fetchAttachments = deps.fetchAttachments ?? noopFetchAttachments
    this.logger = deps.logger ?? noopLogger
  }

  async resolve(request: ContextRequest): Promise<readonly ContextFragment[]> {
    const policy = request.attachments
    if (!policy.enabled) return []

    let attachments: readonly AttachmentInput[]
    try {
      attachments = await this.fetchAttachments(request.item)
    } catch (error) {
      this.logger.warn('failed to list attachments', {
        item: request.item.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    const eligible = attachments
      .filter((attachment) => policy.allowedTypes.includes(attachment.type))
      .filter((attachment) => attachment.sizeBytes <= policy.maxBytesPerAttachment)
      .slice(0, policy.maxAttachments)

    const fragments: ContextFragment[] = []
    for (const attachment of eligible) {
      let text: string
      try {
        text = await attachment.text()
      } catch (error) {
        this.logger.warn('failed to extract attachment text', {
          name: attachment.name,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      fragments.push({
        resolverId: this.id,
        kind: 'attachment',
        title: `Attachment: ${attachment.name}`,
        content: truncate(text, policy.maxExtractedChars),
        priority: 30,
        provenance: `attachment ${attachment.name} on ${workItemProvenance(request.item)}`,
      })
    }
    return fragments
  }
}

export interface DefaultContextResolverDeps {
  readonly work: (providerId: string) => WorkProvider | undefined
  readonly instructionProviders: readonly InstructionProvider[]
  readonly repositoryPaths: () => readonly string[]
  readonly focusDirectories?: () => readonly string[]
  readonly fetchAttachments?: FetchAttachments
  readonly logger?: Logger
}

/** The stock resolver pipeline, in deterministic execution order. */
export function createDefaultContextResolvers(
  deps: DefaultContextResolverDeps,
): readonly ContextResolver[] {
  const logger = deps.logger !== undefined ? { logger: deps.logger } : {}
  return [
    new WorkItemContextResolver(),
    new InstructionContextResolver({
      providers: deps.instructionProviders,
      repositoryPaths: deps.repositoryPaths,
      ...(deps.focusDirectories !== undefined ? { focusDirectories: deps.focusDirectories } : {}),
      ...logger,
    }),
    new RelationshipContextResolver({ work: deps.work, ...logger }),
    new AttachmentContextResolver({
      ...(deps.fetchAttachments !== undefined ? { fetchAttachments: deps.fetchAttachments } : {}),
      ...logger,
    }),
  ]
}
