/**
 * Durable waits and human input (ADR-0019). A run that reaches a wait
 * persists a WaitCondition and its checkpoint, releases model resources,
 * and leaves RUNNING. Satisfactions arrive as events; the first valid
 * response wins atomically; later responses become supplemental context.
 */

import type { HumanInputRequestSpec, WaitKind } from './graph.js'
import type { RunId } from './ids.js'

export type WaitConditionStatus = 'open' | 'satisfied' | 'expired' | 'cancelled'

export interface WaitCondition {
  readonly id: string
  readonly runId: RunId
  readonly nodeId: string
  readonly kind: WaitKind
  readonly parameters: Readonly<Record<string, unknown>>
  /** Human-input/approval waits carry their typed request. */
  readonly request?: HumanInputRequestSpec
  readonly status: WaitConditionStatus
  readonly createdAt: Date
  /** Absolute due time for `time` waits and request timeouts. */
  readonly dueAt?: Date
  readonly satisfiedAt?: Date
  readonly satisfaction?: WaitSatisfaction
}

export type HumanInputChannel = 'app' | 'work_item'

/** Normalized response, whatever channel produced it. */
export interface HumanInput {
  readonly requestId: string
  readonly responder: string
  readonly channel: HumanInputChannel
  readonly at: Date
  /**
   * Typed value: string for text/single-choice/free-form, boolean for
   * boolean/approval, string[] for multiple-choice, secret NAME (never
   * the value) for secret, reference string for file-reference.
   */
  readonly value: unknown
}

export interface WaitSatisfaction {
  readonly kind: WaitKind
  readonly at: Date
  /** Present for human-input/approval satisfactions. */
  readonly input?: HumanInput
  /** Present for event-shaped satisfactions. */
  readonly event?: Readonly<Record<string, unknown>>
}

/** Responses received after satisfaction; never auto-applied (ADR-0019). */
export interface SupplementalInput {
  readonly waitId: string
  readonly runId: RunId
  readonly input: HumanInput
  /** Set when explicitly promoted into a later spec revision. */
  readonly promotedAt?: Date
}

export class InputValidationFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputValidationFailure'
  }
}

/** Validate a response value against its request spec. Throws on mismatch. */
export function validateHumanInputValue(spec: HumanInputRequestSpec, value: unknown): void {
  switch (spec.type) {
    case 'text':
    case 'free-form':
    case 'file-reference':
      if (typeof value !== 'string' || value.length === 0) {
        throw new InputValidationFailure(`${spec.type} response requires a non-empty string`)
      }
      return
    case 'secret':
      if (typeof value !== 'string' || value.length === 0) {
        throw new InputValidationFailure('secret response must be the stored secret name')
      }
      return
    case 'boolean':
    case 'approval':
      if (typeof value !== 'boolean') {
        throw new InputValidationFailure(`${spec.type} response requires true or false`)
      }
      return
    case 'single-choice': {
      if (typeof value !== 'string' || !(spec.choices ?? []).includes(value)) {
        throw new InputValidationFailure(
          `response must be one of: ${(spec.choices ?? []).join(', ')}`,
        )
      }
      return
    }
    case 'multiple-choice': {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((entry) => typeof entry === 'string' && (spec.choices ?? []).includes(entry))
      ) {
        throw new InputValidationFailure(
          `response must be a non-empty subset of: ${(spec.choices ?? []).join(', ')}`,
        )
      }
      return
    }
  }
}

/** Repository port for durable waits. */
export interface WaitRepository {
  save(condition: WaitCondition): Promise<void>
  get(id: string): Promise<WaitCondition | undefined>
  listOpen(filter?: {
    readonly runId?: RunId
    readonly kind?: WaitKind
    readonly dueBefore?: Date
  }): Promise<readonly WaitCondition[]>
  /**
   * Atomically satisfy an open condition (first valid response wins).
   * Returns false when the condition was not open.
   */
  trySatisfy(id: string, satisfaction: WaitSatisfaction): Promise<boolean>
  cancelForRun(runId: RunId): Promise<void>
  addSupplemental(entry: SupplementalInput): Promise<void>
  listSupplemental(runId: RunId): Promise<readonly SupplementalInput[]>
  markSupplementalPromoted(waitId: string, at: Date): Promise<void>
}
