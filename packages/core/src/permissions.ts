/**
 * Permission model. Agents can execute dangerous operations; every tool
 * invocation is checked against policy before execution.
 */

export const PermissionCapability = {
  FilesystemRead: 'filesystem.read',
  FilesystemWrite: 'filesystem.write',
  ProcessExecute: 'process.execute',
  NetworkConnect: 'network.connect',
  GitRead: 'git.read',
  GitWrite: 'git.write',
  IssueRead: 'issue.read',
  IssueWrite: 'issue.write',
  SecretRead: 'secret.read',
  BrowserUse: 'browser.use',
  ComputerUse: 'computer.use',
  ContainerUse: 'container.use',
} as const

export type PermissionCapability = (typeof PermissionCapability)[keyof typeof PermissionCapability]

export type PolicyEffect = 'allow' | 'deny' | 'ask' | 'sandbox-only'

export interface PermissionRequest {
  readonly capability: PermissionCapability
  /** Capability-specific target: path, command, host, secret name, … */
  readonly target?: string
  readonly runId?: string
  readonly toolName?: string
}

export interface PolicyDecision {
  readonly effect: PolicyEffect
  readonly reason?: string
  /** Rule identifier that produced the decision, for audit. */
  readonly ruleId?: string
}

export interface PermissionRule {
  readonly id: string
  readonly capability: PermissionCapability
  /** Glob-style target pattern; matches all targets when omitted. */
  readonly target?: string
  readonly effect: PolicyEffect
}

/** Decides whether a requested operation may proceed. */
export interface PolicyEngine {
  evaluate(request: PermissionRequest): PolicyDecision
}

/**
 * Resolves `ask` decisions by consulting a human. Implementations: UI prompt,
 * CLI prompt, auto-deny for headless runs.
 */
export interface ApprovalGateway {
  requestApproval(request: PermissionRequest, decision: PolicyDecision): Promise<boolean>
}
