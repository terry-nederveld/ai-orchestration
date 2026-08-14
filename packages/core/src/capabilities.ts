/**
 * Capability-based provider negotiation.
 *
 * Providers advertise capabilities; orchestration code asks for capabilities
 * instead of branching on provider names.
 */

export const Capability = {
  Chat: 'chat',
  Reasoning: 'reasoning',
  ToolUse: 'tool_use',
  ParallelToolUse: 'parallel_tool_use',
  StructuredOutput: 'structured_output',
  Vision: 'vision',
  WebSearch: 'web_search',
  ComputerUse: 'computer_use',
  CodeExecution: 'code_execution',
  LongContext: 'long_context',
  ContextCompaction: 'context_compaction',
  Subagents: 'subagents',
  BackgroundTasks: 'background_tasks',
  Mcp: 'mcp',
  Skills: 'skills',
  Hooks: 'hooks',
  Streaming: 'streaming',
  ResumeSession: 'resume_session',
} as const

export type Capability = (typeof Capability)[keyof typeof Capability]

/** Immutable set of capabilities with convenience queries. */
export class CapabilitySet {
  private readonly set: ReadonlySet<Capability>

  constructor(capabilities: Iterable<Capability> = []) {
    this.set = new Set(capabilities)
  }

  static of(...capabilities: Capability[]): CapabilitySet {
    return new CapabilitySet(capabilities)
  }

  has(capability: Capability): boolean {
    return this.set.has(capability)
  }

  hasAll(capabilities: Iterable<Capability>): boolean {
    for (const c of capabilities) if (!this.set.has(c)) return false
    return true
  }

  missing(capabilities: Iterable<Capability>): Capability[] {
    return [...capabilities].filter((c) => !this.set.has(c))
  }

  with(...capabilities: Capability[]): CapabilitySet {
    return new CapabilitySet([...this.set, ...capabilities])
  }

  values(): Capability[] {
    return [...this.set]
  }
}

/** Consumption model a provider bills against. */
export type ConsumptionModel = 'api-usage' | 'subscription' | 'local' | 'free'

export type AuthenticationKind =
  | 'api-key'
  | 'oauth'
  | 'device-code'
  | 'cli-session'
  | 'cloud-credentials'
  | 'none'

/** Static identity metadata every provider exposes. */
export interface ProviderInfo {
  /** Stable machine identifier, e.g. `anthropic`, `github`, `jira-cloud`. */
  readonly id: string
  readonly displayName: string
  readonly kind: 'model' | 'agent' | 'work' | 'scm' | 'workspace' | 'secret' | 'notification'
  readonly consumption: ConsumptionModel
  readonly authentication: readonly AuthenticationKind[]
}

/** Result of probing whether a provider is usable in this environment. */
export interface ProviderAvailability {
  readonly installed: boolean
  readonly authenticated: boolean
  readonly available: boolean
  readonly authenticationKind?: AuthenticationKind
  readonly detail?: string
  /** Model identifiers known to be usable, when discoverable. */
  readonly models?: readonly string[]
}
