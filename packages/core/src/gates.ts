/**
 * Gate sets (mission §18): reusable, versioned Definition of Ready /
 * Definition of Done. Gates are deterministic (expression/command),
 * agent-evaluated, or human-approved. Evaluation and remediation are
 * separate by construction: a remediator never declares its own fix
 * successful — the gate re-evaluates independently afterwards.
 */

export type GateKind = 'deterministic' | 'agent' | 'human'

export interface GateRemediation {
  /** Goal handed to the remediation agent when the gate fails. */
  readonly goal: string
  readonly maxAttempts: number
}

export interface Gate {
  readonly id: string
  readonly description: string
  readonly kind: GateKind
  /**
   * deterministic: expression over `item`, `outputs`, `domain`, `vars`
   * (or `command:` prefix for a workspace command whose exit 0 passes).
   * agent: the evaluation goal; the agent returns { passed, reason }.
   * human: the approval prompt.
   */
  readonly check: string
  readonly remediation?: GateRemediation
  /** Failing a required gate fails the gate set; advisory gates warn. */
  readonly required: boolean
}

export interface GateSet {
  readonly name: string
  readonly description?: string
  readonly gates: readonly Gate[]
  /** Gate sets compose: extended sets prepend their base's gates. */
  readonly extends?: readonly string[]
}

export interface GateEvaluation {
  readonly gateId: string
  readonly passed: boolean
  readonly reason: string
  readonly evaluatedBy: 'expression' | 'command' | 'agent' | 'human'
  readonly attempt: number
  readonly at: Date
}

export interface GateSetResult {
  readonly gateSetName: string
  readonly gateSetVersion: number
  readonly passed: boolean
  readonly evaluations: readonly GateEvaluation[]
  readonly remediationsAttempted: number
}

/** Flatten a gate set with its (already-resolved) bases, bases first. */
export function composeGateSets(
  target: GateSet,
  resolvedBases: readonly GateSet[],
): readonly Gate[] {
  const seen = new Set<string>()
  const gates: Gate[] = []
  for (const set of [...resolvedBases, target]) {
    for (const gate of set.gates) {
      if (seen.has(gate.id)) continue
      seen.add(gate.id)
      gates.push(gate)
    }
  }
  return gates
}
