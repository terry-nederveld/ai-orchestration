/**
 * Kernel-level ports. These are composition seams specific to orchestration:
 * how agent steps find an executor, how commands run, and how per-run
 * workflow actions are assembled. All are vendor-neutral.
 */

import type {
  AgentRunHandle,
  AgentRunRequest,
  AgentStep,
  Clock,
  EventBus,
  IdGenerator,
  Logger,
  Run,
  SourceControlProvider,
  WorkflowAction,
  WorkItem,
  WorkProvider,
  Workspace,
} from '@overture/core'

/** An executor able to run one agent step (native runtime or agent provider). */
export interface ResolvedAgentExecutor {
  readonly providerId: string
  readonly model?: string
  readonly systemPrompt?: string
  start(request: AgentRunRequest): Promise<AgentRunHandle>
}

/**
 * Maps a workflow agent step (role + optional route) to a concrete executor.
 * Routing profiles, capability requirements, and cost classes live behind
 * this port.
 */
export interface AgentRouter {
  resolve(step: AgentStep): Promise<ResolvedAgentExecutor>
}

export interface CommandResult {
  readonly exitCode: number
  readonly output: string
}

/** Executes workflow command steps inside a working directory. */
export interface CommandRunner {
  run(
    command: string,
    options: {
      readonly cwd: string
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    },
  ): Promise<CommandResult>
}

/** Everything a per-run workflow action may need. */
export interface RunActionContext {
  readonly run: Run
  readonly workItem: WorkItem
  readonly workspace?: Workspace
  readonly branch?: string
  readonly scm?: SourceControlProvider
  readonly work: WorkProvider
  readonly events: EventBus
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
}

export type WorkflowActionFactory = (context: RunActionContext) => readonly WorkflowAction[]

/** Assembles the action set available to a run's workflow. */
export class WorkflowActionRegistry {
  private readonly factories: WorkflowActionFactory[] = []

  register(factory: WorkflowActionFactory): void {
    this.factories.push(factory)
  }

  forRun(context: RunActionContext): ReadonlyMap<string, WorkflowAction> {
    const actions = new Map<string, WorkflowAction>()
    for (const factory of this.factories) {
      for (const action of factory(context)) {
        actions.set(action.id, action)
      }
    }
    return actions
  }
}
