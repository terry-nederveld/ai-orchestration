/**
 * Composition helper that wires a discovered set of extensions into the
 * rest of the system: hooks go into the hook registry, contributed tools
 * are wrapped in a `ToolProvider` and registered, and workflow actions are
 * forwarded to a sink. A single crashing extension is isolated — it is
 * recorded as failed and every other extension still loads.
 */

import type {
  Extension,
  ExtensionProvider,
  HookRegistry,
  Logger,
  Tool,
  ToolProvider,
  WorkflowAction,
} from '@overture/core'

export interface ExtensionHostOptions {
  readonly provider: ExtensionProvider
  readonly hookRegistry: HookRegistry
  readonly toolRegistry?: { register(provider: ToolProvider): void }
  readonly actionSink?: (actions: readonly WorkflowAction[]) => void
  readonly logger: Logger
}

export interface ExtensionLoadFailure {
  readonly id: string
  readonly error: string
}

export interface ExtensionLoadSummary {
  readonly loaded: readonly string[]
  readonly failed: readonly ExtensionLoadFailure[]
}

class StaticToolProvider implements ToolProvider {
  readonly id: string
  private readonly tools: readonly Tool[]

  constructor(id: string, tools: readonly Tool[]) {
    this.id = id
    this.tools = tools
  }

  async listTools(): Promise<readonly Tool[]> {
    return this.tools
  }
}

export class ExtensionHost {
  private readonly provider: ExtensionProvider
  private readonly hookRegistry: HookRegistry
  private readonly toolRegistry: { register(provider: ToolProvider): void } | undefined
  private readonly actionSink: ((actions: readonly WorkflowAction[]) => void) | undefined
  private readonly logger: Logger

  constructor(options: ExtensionHostOptions) {
    this.provider = options.provider
    this.hookRegistry = options.hookRegistry
    this.toolRegistry = options.toolRegistry
    this.actionSink = options.actionSink
    this.logger = options.logger
  }

  async loadAll(): Promise<ExtensionLoadSummary> {
    const manifests = await this.provider.discover()
    const loaded: string[] = []
    const failed: ExtensionLoadFailure[] = []

    for (const manifest of manifests) {
      try {
        const extension = await this.provider.load(manifest.id)
        this.wire(extension)
        loaded.push(manifest.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error('extension failed to load; skipping', {
          extension: manifest.id,
          error: message,
        })
        failed.push({ id: manifest.id, error: message })
      }
    }

    return { loaded, failed }
  }

  private wire(extension: Extension): void {
    for (const hook of extension.hooks ?? []) {
      this.hookRegistry.register(hook.point, hook.handler, extension.manifest.id)
    }

    if (
      extension.tools !== undefined &&
      extension.tools.length > 0 &&
      this.toolRegistry !== undefined
    ) {
      this.toolRegistry.register(new StaticToolProvider(extension.manifest.id, extension.tools))
    }

    if (extension.workflowActions !== undefined && extension.workflowActions.length > 0) {
      this.actionSink?.(extension.workflowActions)
    }
  }
}
