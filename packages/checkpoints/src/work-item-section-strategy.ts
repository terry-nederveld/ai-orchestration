/**
 * WorkItemSectionCheckpointStrategy: durable checkpoints for non-code runs.
 * Progress is persisted into the managed section of the originating work
 * item's description (see core's upsertManagedSection), preserving every
 * character humans wrote outside the delimiters. A body whose delimiters were
 * tampered with is never overwritten: the checkpoint records the refusal and
 * a comment on the item flags it for a human.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  type Checkpoint,
  type CheckpointContext,
  type CheckpointStrategy,
  type Clock,
  OrchestratorError,
  readManagedSection,
  systemClock,
  upsertManagedSection,
  type WorkItem,
  type WorkProvider,
} from '@overture/core'

export interface ResolvedWorkItem {
  readonly provider: WorkProvider
  readonly item: WorkItem
}

/** Injected port: the orchestrator knows which provider owns a work item. */
export type WorkItemResolver = (workItemId: string) => Promise<ResolvedWorkItem | undefined>

export interface WorkItemSectionCheckpointStrategyOptions {
  readonly resolveItem: WorkItemResolver
  readonly clock?: Clock
}

export class WorkItemSectionCheckpointStrategy implements CheckpointStrategy {
  readonly id = 'work-item-section'

  private readonly resolveItem: WorkItemResolver
  private readonly clock: Clock

  constructor(options: WorkItemSectionCheckpointStrategyOptions) {
    this.resolveItem = options.resolveItem
    this.clock = options.clock ?? systemClock
  }

  async checkpoint(context: CheckpointContext): Promise<Checkpoint> {
    const workItemId = context.workItemId
    if (!workItemId) {
      throw new OrchestratorError(
        'work-item-section checkpoints require a workItemId',
        'invalid-input',
      )
    }
    const { provider, item } = await this.resolve(workItemId)
    if (!provider.updateDescription) {
      throw new OrchestratorError(
        `work provider "${provider.info.id}" does not support description updates`,
        'capability-mismatch',
      )
    }

    const now = this.clock.now()
    const body = await fetchBody(provider, item)
    const managedContent = renderStatusBlock(context, now)
    const result = upsertManagedSection(body, managedContent)

    const base = {
      id: `cp-${randomUUID()}`,
      runId: context.runId,
      nodeId: context.nodeId,
      strategy: this.id,
      createdAt: now,
      summary: context.summary,
      specRevision: context.specRevision,
    }

    if (!result.applied) {
      const reason = result.reason ?? 'managed-section delimiters are damaged'
      await provider.comment(item, {
        body: `Overture checkpoint: could not update this item's description (${reason}). Latest status: ${context.summary}`,
      })
      return { ...base, coordinates: { workItemId, applied: false, reason } }
    }

    await provider.updateDescription(item, result.body)
    return {
      ...base,
      coordinates: { workItemId, contentHash: sha256(managedContent), applied: true },
    }
  }

  async restore(checkpoint: Checkpoint): Promise<Readonly<Record<string, unknown>>> {
    const workItemId = checkpoint.coordinates.workItemId
    if (typeof workItemId !== 'string' || workItemId.length === 0) {
      throw new OrchestratorError(
        `checkpoint ${checkpoint.id} is missing the "workItemId" coordinate`,
        'invalid-input',
      )
    }
    const { provider, item } = await this.resolve(workItemId)
    const body = await fetchBody(provider, item)
    // Humans may have removed the section entirely; that is theirs to do, so
    // report the absence rather than throwing.
    return { managedContent: readManagedSection(body) }
  }

  private async resolve(workItemId: string): Promise<ResolvedWorkItem> {
    const resolved = await this.resolveItem(workItemId)
    if (!resolved) {
      throw new OrchestratorError(`work item not found: ${workItemId}`, 'invalid-input')
    }
    return resolved
  }
}

async function fetchBody(provider: WorkProvider, item: WorkItem): Promise<string> {
  if (provider.getDescription) return provider.getDescription(item)
  return item.description ?? ''
}

function renderStatusBlock(context: CheckpointContext, now: Date): string {
  return [
    '### Overture checkpoint',
    '',
    context.summary.trim(),
    '',
    `- Spec revision: ${context.specRevision}`,
    `- Updated: ${now.toISOString()}`,
    `- run: ${context.runId}`,
  ].join('\n')
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
