/**
 * Tool contract. Tools are the only way agents affect the world; every
 * execution passes through permission checks and emits observable events.
 */

import type { Logger } from './ids.js'
import type { ToolDescriptor } from './model.js'
import type { PermissionCapability } from './permissions.js'
import type { Workspace } from './workspace.js'

export interface ToolExecutionContext {
  readonly runId: string
  readonly sessionId: string
  readonly workspace?: Workspace
  readonly logger: Logger
  readonly signal: AbortSignal
  /**
   * Resolve a named secret for side-channel use (e.g. env var injection into
   * a subprocess). Raw values must not be placed into model context.
   */
  resolveSecret(name: string): Promise<string | undefined>
}

export interface ToolResult {
  readonly content: string
  readonly isError?: boolean
  /** Structured payload for observers; not sent to the model. */
  readonly detail?: unknown
}

export interface Tool {
  readonly descriptor: ToolDescriptor
  /** Permissions this tool needs; checked before every execution. */
  readonly requiredPermissions: readonly PermissionCapability[]
  /**
   * Policy target for a given input (e.g. `mcp:<server>:<tool>`); when
   * absent, the runtime derives a target from well-known input keys.
   */
  policyTarget?(input: unknown): string | undefined
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>
}

/** Source of tools: built-ins, extensions, MCP servers. */
export interface ToolProvider {
  readonly id: string
  listTools(): Promise<readonly Tool[]>
}

/** Aggregates tool providers into the flat tool set offered to an agent. */
export interface ToolRegistry {
  register(provider: ToolProvider): void
  resolve(names?: readonly string[]): Promise<readonly Tool[]>
}
