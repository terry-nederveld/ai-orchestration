/**
 * RunCoordinator: drives one work item through one workflow — workspace
 * preparation, engine execution, usage aggregation, delivery transition, and
 * cleanup — persisting every state change and emitting events throughout.
 */

import type {
  ApprovalGateway,
  Clock,
  EventBus,
  IdGenerator,
  Logger,
  OrchestratorEventPayload,
  PersistenceProvider,
  Run,
  RunId,
  RunState as RunStateType,
  SourceControlProvider,
  UsageRecord,
  WorkflowDefinition,
  WorkItem,
  WorkProvider,
  Workspace,
  WorkspaceProvider,
  WorkspaceRetention,
} from '@overture/core'
import {
  asId,
  assertTransition,
  emptyTokenUsage,
  OrchestratorError,
  RunState,
} from '@overture/core'
import { WorkflowEngine, type WorkflowResult } from '@overture/workflow'
import { createStepExecutors } from './executors.js'
import type { AgentRouter, CommandRunner, WorkflowActionRegistry } from './ports.js'

/** Minimal port for resolving workspace strategies. */
export interface WorkspaceResolver {
  resolve(strategy: string): WorkspaceProvider | undefined
}

/** Resolves the work provider a given item belongs to. */
export interface WorkProviderResolver {
  resolve(providerId: string): WorkProvider | undefined
}

export interface RunCoordinatorOptions {
  readonly work: WorkProviderResolver
  readonly workspaces: WorkspaceResolver
  readonly agents: AgentRouter
  readonly commands: CommandRunner
  readonly actions: WorkflowActionRegistry
  readonly approvals: ApprovalGateway
  readonly persistence: PersistenceProvider
  readonly events: EventBus
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
  readonly scm?: SourceControlProvider
  /** Identifies this orchestrator instance in external claim markers. */
  readonly claimant: string
  readonly branchPrefix?: string
  readonly stepConcurrency?: number
}

interface ActiveRun {
  readonly abort: AbortController
}

export class RunCoordinator {
  private readonly engine = new WorkflowEngine()
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly options: RunCoordinatorOptions) {}

  activeRunIds(): readonly string[] {
    return [...this.active.keys()]
  }

  async cancel(runId: RunId, reason = 'cancelled'): Promise<boolean> {
    const active = this.active.get(String(runId))
    if (!active) return false
    active.abort.abort(new Error(reason))
    return true
  }

  /**
   * Execute a claimed work item through a workflow. The caller has already
   * won the authoritative claim; this method owns everything after that.
   */
  async execute(item: WorkItem, definition: WorkflowDefinition, runId: RunId): Promise<Run> {
    const { clock, logger } = this.options
    const work = this.options.work.resolve(item.provider)
    if (!work) {
      throw new OrchestratorError(`no work provider for '${item.provider}'`, 'invalid-input')
    }
    const abort = new AbortController()
    this.active.set(String(runId), { abort })

    let run: Run = {
      id: runId,
      workItemId: item.id,
      workflowName: definition.name,
      state: RunState.Queued,
      sessionIds: [],
      createdAt: clock.now(),
      updatedAt: clock.now(),
      history: [],
    }
    await this.options.persistence.runs.save(run)

    let workspace: Workspace | undefined
    let failed = true
    try {
      run = await this.transition(run, RunState.Preparing)

      await this.markClaim(item, runId, work)

      const branch = this.branchName(item)
      workspace = await this.prepareWorkspace(item, definition, runId, branch)
      if (workspace) {
        run = await this.persistRun({ ...run, workspaceId: workspace.id })
        this.publish(run.id, {
          type: 'workspace.created',
          workspaceId: String(workspace.id),
          path: workspace.path,
        })
      }

      run = await this.transition(run, RunState.Running)

      const sessionIds: string[] = []
      const result = await this.engine.execute(definition, {
        executors: createStepExecutors({
          run,
          workItem: item,
          definition,
          ...(workspace ? { workspace } : {}),
          agents: this.options.agents,
          commands: this.options.commands,
          actions: this.options.actions.forRun({
            run,
            workItem: item,
            ...(workspace ? { workspace } : {}),
            ...(workspace?.branch ? { branch: workspace.branch } : {}),
            ...(this.options.scm ? { scm: this.options.scm } : {}),
            work,
            events: this.options.events,
            clock: this.options.clock,
            ids: this.options.ids,
            logger,
          }),
          approvals: this.options.approvals,
          events: this.options.events,
          clock: this.options.clock,
          ids: this.options.ids,
          logger,
          signal: abort.signal,
          onSessionStarted: (sessionId) => sessionIds.push(sessionId),
        }),
        variables: this.workflowVariables(item, workspace),
        signal: abort.signal,
        ...(this.options.stepConcurrency !== undefined
          ? { concurrency: this.options.stepConcurrency }
          : {}),
        clock: this.options.clock,
        onEvent: (event) => this.publishEngineEvent(run.id, event),
      })

      const usage = aggregateUsage(result)
      run = await this.persistRun({
        ...run,
        sessionIds: sessionIds.map((id) => asId<'session'>(id)),
        ...(usage ? { usage } : {}),
      })
      if (usage) await this.options.persistence.usage.record(run.id, usage)

      run = await this.finalize(run, item, definition, result, work)
      failed = run.state !== RunState.Completed
      return run
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('run failed', { runId: String(runId), error: message })
      this.publish(runId, { type: 'error', scope: 'run', message })
      const target = abort.signal.aborted ? RunState.Cancelled : RunState.Failed
      if (run.state !== target) {
        run = await this.transition(run, target, message).catch(() => run)
      }
      return run
    } finally {
      this.active.delete(String(runId))
      await this.releaseClaim(item, runId, work)
      if (workspace) {
        await this.cleanupWorkspace(workspace, definition, failed)
      }
    }
  }

  private async finalize(
    run: Run,
    item: WorkItem,
    _definition: WorkflowDefinition,
    result: WorkflowResult,
    work: WorkProvider,
  ): Promise<Run> {
    const summary = finalSummary(result)
    let target: RunStateType
    if (result.status === 'succeeded') target = RunState.Completed
    else if (result.status === 'cancelled') target = RunState.Cancelled
    else target = result.transition === 'blocked' ? RunState.Blocked : RunState.Failed

    if (result.transitionTarget) {
      try {
        await work.transition(item, {
          targetState: result.transitionTarget,
          ...(summary ? { comment: summary } : {}),
        })
        this.publish(run.id, {
          type: 'workflow.transitioned',
          runId: run.id,
          transition: `${result.transition} -> ${result.transitionTarget}`,
        })
      } catch (error) {
        this.options.logger.warn('work item transition failed', {
          runId: String(run.id),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return this.transition(run, target, summary)
  }

  private async prepareWorkspace(
    item: WorkItem,
    definition: WorkflowDefinition,
    runId: RunId,
    branch: string,
  ): Promise<Workspace | undefined> {
    const strategyName = definition.workspace?.strategy ?? 'git-worktree'
    if (strategyName === 'none') return undefined
    const provider = this.options.workspaces.resolve(strategyName)
    if (!provider) {
      throw new OrchestratorError(
        `no workspace provider for strategy '${strategyName}'`,
        'invalid-input',
      )
    }
    return provider.create({
      runId,
      ...(item.repository ? { repository: item.repository } : {}),
      branch,
    })
  }

  private async cleanupWorkspace(
    workspace: Workspace,
    definition: WorkflowDefinition,
    failed: boolean,
  ): Promise<void> {
    const retention: WorkspaceRetention = definition.workspace?.retention ?? 'on-failure'
    const provider = this.options.workspaces.resolve(workspace.strategy)
    if (!provider) return
    try {
      await provider.cleanup(workspace, retention, failed)
      this.publish(undefined, { type: 'workspace.cleaned', workspaceId: String(workspace.id) })
    } catch (error) {
      this.options.logger.warn('workspace cleanup failed', {
        workspaceId: String(workspace.id),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async markClaim(item: WorkItem, runId: RunId, work: WorkProvider): Promise<void> {
    try {
      await work.claim(item, {
        claimant: this.options.claimant,
        runId: String(runId),
      })
    } catch (error) {
      // The authoritative claim is ours already; the external marker is
      // best-effort visibility.
      this.options.logger.warn('external claim marker failed', {
        workItemId: String(item.id),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async releaseClaim(item: WorkItem, runId: RunId, work: WorkProvider): Promise<void> {
    await this.options.persistence.claims.release(item.id, runId).catch(() => {})
    try {
      await work.release(item, {
        claimant: this.options.claimant,
        runId: String(runId),
      })
    } catch {
      // Best-effort; the local claim release above is what matters.
    }
  }

  private workflowVariables(
    item: WorkItem,
    workspace: Workspace | undefined,
  ): Readonly<Record<string, unknown>> {
    return {
      work_id: item.externalId,
      work_title: item.title,
      work_url: item.url ?? '',
      work_state: item.state,
      work_provider: item.provider,
      workspace_path: workspace?.path ?? '',
      branch: workspace?.branch ?? '',
    }
  }

  private branchName(item: WorkItem): string {
    const prefix = this.options.branchPrefix ?? 'overture'
    const slug = item.externalId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
    return `${prefix}/${slug}`
  }

  private async transition(run: Run, to: RunStateType, reason?: string): Promise<Run> {
    assertTransition(run.state, to)
    const now = this.options.clock.now()
    const updated: Run = {
      ...run,
      state: to,
      updatedAt: now,
      history: [...run.history, { from: run.state, to, at: now, ...(reason ? { reason } : {}) }],
    }
    await this.options.persistence.runs.save(updated)
    this.publish(run.id, {
      type: 'run.state.changed',
      runId: run.id,
      from: run.state,
      to,
      ...(reason ? { reason } : {}),
    })
    return updated
  }

  private async persistRun(run: Run): Promise<Run> {
    const updated = { ...run, updatedAt: this.options.clock.now() }
    await this.options.persistence.runs.save(updated)
    return updated
  }

  private publishEngineEvent(
    runId: RunId,
    event:
      | { type: 'step.started'; stepId: string }
      | { type: 'step.completed'; stepId: string; status: string }
      | { type: 'step.skipped'; stepId: string; reason: string },
  ): void {
    if (event.type === 'step.started') {
      this.publish(runId, { type: 'workflow.step.started', runId, stepId: event.stepId })
    } else if (event.type === 'step.completed') {
      this.publish(runId, {
        type: 'workflow.step.completed',
        runId,
        stepId: event.stepId,
        status: event.status === 'succeeded' ? 'succeeded' : 'failed',
      })
    } else {
      this.publish(runId, {
        type: 'workflow.step.completed',
        runId,
        stepId: event.stepId,
        status: 'skipped',
      })
    }
  }

  private publish(runId: RunId | undefined, payload: OrchestratorEventPayload): void {
    this.options.events.publish({
      id: asId(this.options.ids.next('evt')),
      at: this.options.clock.now(),
      ...(runId ? { runId } : {}),
      ...payload,
    })
  }
}

function aggregateUsage(result: WorkflowResult): UsageRecord | undefined {
  let tokens = emptyTokenUsage
  let turns = 0
  let provider: string | undefined
  let model: string | undefined
  for (const step of result.stepResults.values()) {
    const outputs = step.outputs
    if (typeof outputs.inputTokens === 'number' && typeof outputs.outputTokens === 'number') {
      tokens = {
        inputTokens: tokens.inputTokens + outputs.inputTokens,
        outputTokens: tokens.outputTokens + outputs.outputTokens,
      }
      if (typeof outputs.turns === 'number') turns += outputs.turns
      if (typeof outputs.provider === 'string') provider = outputs.provider
      if (typeof outputs.model === 'string') model = outputs.model
    }
  }
  if (!provider) return undefined
  const durations = [...result.stepResults.values()]
    .map((step) =>
      step.startedAt && step.finishedAt ? step.finishedAt.getTime() - step.startedAt.getTime() : 0,
    )
    .reduce((a, b) => a + b, 0)
  return {
    provider,
    ...(model ? { model } : {}),
    tokens,
    durationMs: durations,
    turns,
    subagents: 0,
  }
}

function finalSummary(result: WorkflowResult): string {
  const summaries: string[] = []
  for (const [stepId, step] of result.stepResults) {
    const summary = step.outputs.summary
    if (typeof summary === 'string' && summary.length > 0) {
      summaries.push(`${stepId}: ${summary.slice(0, 500)}`)
    }
    const url = step.outputs.url
    if (typeof url === 'string' && url.length > 0) summaries.push(`${stepId}: ${url}`)
    if (step.status === 'failed' && step.error) summaries.push(`${stepId} failed: ${step.error}`)
  }
  return summaries.join('\n')
}
