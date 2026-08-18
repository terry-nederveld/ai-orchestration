/**
 * Agent profiles (mission §19): reusable versioned execution
 * configurations composed from fragments — never inherited. A profile
 * resolves to provider/model, an ordered fallback chain, instruction and
 * context policy, tools, permissions, and budget.
 */

import type { BudgetLimits } from './budget.js'
import type { Capability } from './capabilities.js'
import type { AttachmentPolicy, TraversalPolicy } from './context.js'
import type { PermissionRule } from './permissions.js'

export interface ModelSelection {
  /** Executor id: 'native-<provider>' or an agent provider id. */
  readonly executor: string
  readonly model?: string
  /** Capabilities this selection must satisfy (checked at resolution). */
  readonly requires?: readonly Capability[]
}

export interface FallbackPolicy {
  /** Ordered alternatives tried after the primary. */
  readonly chain: readonly ModelSelection[]
  /**
   * When fallback may engage: 'outage-only' restricts to provider
   * outages/rate limits; 'any-failure' includes fatal model errors.
   */
  readonly trigger: 'outage-only' | 'any-failure'
  /** Every fallback selection must still satisfy these capabilities. */
  readonly minimumCapabilities?: readonly Capability[]
}

/** A composable fragment; later fragments override scalar fields. */
export interface ProfileFragment {
  readonly primary?: ModelSelection
  readonly fallback?: FallbackPolicy
  readonly systemPrompt?: string
  readonly toolNames?: readonly string[]
  readonly permissions?: readonly PermissionRule[]
  readonly budget?: BudgetLimits
  readonly traversal?: TraversalPolicy
  readonly attachments?: AttachmentPolicy
  readonly maxTurns?: number
  readonly timeoutMs?: number
}

export interface AgentProfileDefinition {
  readonly name: string
  readonly description?: string
  /** Names of fragments (agent-profile definitions) composed in order. */
  readonly compose?: readonly string[]
  readonly fragment: ProfileFragment
}

/** Fully-resolved profile after composition. */
export interface ResolvedProfile {
  readonly name: string
  readonly primary: ModelSelection
  readonly fallback?: FallbackPolicy
  readonly systemPrompt?: string
  readonly toolNames?: readonly string[]
  readonly permissions: readonly PermissionRule[]
  readonly budget?: BudgetLimits
  readonly traversal?: TraversalPolicy
  readonly attachments?: AttachmentPolicy
  readonly maxTurns?: number
  readonly timeoutMs?: number
  /** Fragment names in application order, for provenance. */
  readonly composedFrom: readonly string[]
}

export class ProfileCompositionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileCompositionError'
  }
}

/**
 * Compose a profile from already-resolved fragments (composition order:
 * listed fragments first, own fragment last; later overrides scalars,
 * permissions concatenate, toolNames union).
 */
export function composeProfile(
  definition: AgentProfileDefinition,
  resolvedFragments: readonly ProfileFragment[],
  fragmentNames: readonly string[],
  overrides: Partial<ProfileFragment> = {},
): ResolvedProfile {
  const fragments = [...resolvedFragments, definition.fragment, overrides]
  let primary: ModelSelection | undefined
  let fallback: FallbackPolicy | undefined
  let systemPrompt: string | undefined
  let toolNames: string[] | undefined
  const permissions: PermissionRule[] = []
  let budget: BudgetLimits | undefined
  let traversal: TraversalPolicy | undefined
  let attachments: AttachmentPolicy | undefined
  let maxTurns: number | undefined
  let timeoutMs: number | undefined

  for (const fragment of fragments) {
    if (fragment.primary !== undefined) primary = fragment.primary
    if (fragment.fallback !== undefined) fallback = fragment.fallback
    if (fragment.systemPrompt !== undefined) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${fragment.systemPrompt}`
        : fragment.systemPrompt
    }
    if (fragment.toolNames !== undefined) {
      toolNames = [...new Set([...(toolNames ?? []), ...fragment.toolNames])]
    }
    if (fragment.permissions !== undefined) permissions.push(...fragment.permissions)
    if (fragment.budget !== undefined) budget = fragment.budget
    if (fragment.traversal !== undefined) traversal = fragment.traversal
    if (fragment.attachments !== undefined) attachments = fragment.attachments
    if (fragment.maxTurns !== undefined) maxTurns = fragment.maxTurns
    if (fragment.timeoutMs !== undefined) timeoutMs = fragment.timeoutMs
  }

  if (!primary) {
    throw new ProfileCompositionError(
      `profile '${definition.name}' resolves to no primary model selection`,
    )
  }
  return {
    name: definition.name,
    primary,
    ...(fallback !== undefined ? { fallback } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(toolNames !== undefined ? { toolNames } : {}),
    permissions,
    ...(budget !== undefined ? { budget } : {}),
    ...(traversal !== undefined ? { traversal } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    composedFrom: [...fragmentNames, definition.name],
  }
}
