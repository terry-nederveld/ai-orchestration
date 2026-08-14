/**
 * Agent routing: maps workflow agent roles/routes to concrete executors.
 * Profiles are configuration; capability requirements are checked at
 * resolution time so mismatches fail fast with a clear error.
 */

import type { AgentProvider, AgentStep, Capability } from '@overture/core'
import { OrchestratorError } from '@overture/core'
import type { AgentRouter, ResolvedAgentExecutor } from './ports.js'

export interface RouteProfile {
  /** Registered executor id (agent provider id or 'native'). */
  readonly executor: string
  readonly model?: string
  readonly systemPrompt?: string
  readonly requires?: readonly Capability[]
}

export interface RoutingTable {
  /** Profile name → profile. Step `route` (or role) selects a profile. */
  readonly profiles: Readonly<Record<string, RouteProfile>>
  readonly defaultProfile: string
}

/** An executor registration: either an AgentProvider or the native runtime. */
export interface ExecutorRegistration {
  readonly id: string
  readonly start: ResolvedAgentExecutor['start']
  readonly capabilities?: () => ReturnType<AgentProvider['capabilities']>
}

export class ProfileAgentRouter implements AgentRouter {
  private readonly executors = new Map<string, ExecutorRegistration>()

  constructor(private readonly table: RoutingTable) {}

  register(registration: ExecutorRegistration): void {
    this.executors.set(registration.id, registration)
  }

  async resolve(step: AgentStep): Promise<ResolvedAgentExecutor> {
    const profileName = step.route ?? step.agent
    const profile =
      this.table.profiles[profileName] ?? this.table.profiles[this.table.defaultProfile]
    if (!profile) {
      throw new OrchestratorError(
        `no routing profile for '${profileName}' and no default profile`,
        'invalid-input',
      )
    }
    const executor = this.executors.get(profile.executor)
    if (!executor) {
      throw new OrchestratorError(
        `routing profile '${profileName}' references unknown executor '${profile.executor}'`,
        'invalid-input',
      )
    }
    if (profile.requires && executor.capabilities) {
      const missing = executor.capabilities().missing(profile.requires)
      if (missing.length > 0) {
        throw new OrchestratorError(
          `executor '${executor.id}' lacks required capabilities: ${missing.join(', ')}`,
          'capability-mismatch',
        )
      }
    }
    return {
      providerId: executor.id,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
      start: executor.start,
    }
  }
}
