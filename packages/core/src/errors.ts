/**
 * Error taxonomy. Failures carry a category the orchestrator can act on
 * (retry, re-queue, block, surface to human) instead of string matching.
 */

export type ErrorCategory =
  | 'network'
  | 'rate-limit'
  | 'auth-expired'
  | 'quota-exhausted'
  | 'timeout'
  | 'provider-outage'
  | 'invalid-input'
  | 'conflict'
  | 'policy'
  | 'capability-mismatch'
  | 'corrupt-response'
  | 'internal'

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly options?: {
      readonly retryable?: boolean
      readonly retryAfterMs?: number
      readonly cause?: unknown
    },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'OrchestratorError'
  }

  get retryable(): boolean {
    if (this.options?.retryable !== undefined) return this.options.retryable
    return ['network', 'rate-limit', 'timeout', 'provider-outage'].includes(this.category)
  }
}

export function toOrchestratorError(error: unknown, fallbackCategory: ErrorCategory = 'internal') {
  if (error instanceof OrchestratorError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new OrchestratorError(message, fallbackCategory, { cause: error })
}
