/**
 * Rule-based policy engine. Rules are evaluated in order; the first match
 * wins. No match falls back to the configured default effect (deny-by-default
 * unless explicitly relaxed).
 */

import type {
  PermissionCapability,
  PermissionRequest,
  PermissionRule,
  PolicyDecision,
  PolicyEffect,
  PolicyEngine,
} from '@overture/core'

export interface RulePolicyOptions {
  readonly rules: readonly PermissionRule[]
  /** Effect when no rule matches. Default: 'deny'. */
  readonly defaultEffect?: PolicyEffect
}

export class RuleBasedPolicyEngine implements PolicyEngine {
  private readonly rules: readonly CompiledRule[]
  private readonly defaultEffect: PolicyEffect

  constructor(options: RulePolicyOptions) {
    this.rules = options.rules.map(compileRule)
    this.defaultEffect = options.defaultEffect ?? 'deny'
  }

  evaluate(request: PermissionRequest): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.capability !== request.capability) continue
      if (rule.matcher && !rule.matcher.test(request.target ?? '')) continue
      return {
        effect: rule.effect,
        ruleId: rule.id,
        reason: `rule ${rule.id}`,
      }
    }
    return { effect: this.defaultEffect, reason: 'no matching rule' }
  }
}

interface CompiledRule {
  readonly id: string
  readonly capability: PermissionCapability
  readonly matcher?: RegExp
  readonly effect: PolicyEffect
}

function compileRule(rule: PermissionRule): CompiledRule {
  return {
    id: rule.id,
    capability: rule.capability,
    effect: rule.effect,
    ...(rule.target !== undefined ? { matcher: globToRegExp(rule.target) } : {}),
  }
}

/** Glob for permission targets: `*` matches within a segment, `**` anything. */
function globToRegExp(pattern: string): RegExp {
  let regex = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*'
        i += 1
      } else {
        regex += '[^/]*'
      }
    } else if (char !== undefined && '\\^$.|?+()[]{}'.includes(char)) {
      regex += `\\${char}`
    } else {
      regex += char
    }
  }
  return new RegExp(`^${regex}$`)
}

/** Convenience preset: everything a coding agent needs inside a workspace. */
export function workspaceCodingRules(): PermissionRule[] {
  return [
    { id: 'fs-read', capability: 'filesystem.read', effect: 'allow' },
    { id: 'fs-write', capability: 'filesystem.write', effect: 'allow' },
    { id: 'exec', capability: 'process.execute', effect: 'allow' },
    { id: 'git-read', capability: 'git.read', effect: 'allow' },
    { id: 'git-write', capability: 'git.write', effect: 'allow' },
    { id: 'issue-read', capability: 'issue.read', effect: 'allow' },
    { id: 'issue-write', capability: 'issue.write', effect: 'allow' },
  ]
}
