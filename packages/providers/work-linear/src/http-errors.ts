/**
 * Maps raw fetch/HTTP/GraphQL failures onto the shared OrchestratorError
 * taxonomy so orchestration code never has to branch on Linear-specific
 * status codes or GraphQL error shapes.
 */

import { OrchestratorError } from '@overture/core'
import type { GraphQLError } from './linear-types.js'

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return seconds * 1000
    const dateMs = Date.parse(retryAfter)
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  }
  const resetEpochSeconds = headers.get('x-ratelimit-requests-reset')
  if (resetEpochSeconds) {
    const seconds = Number(resetEpochSeconds)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000 - Date.now())
  }
  return undefined
}

function describeErrorBody(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { errors?: readonly GraphQLError[] }
    if (parsed.errors && parsed.errors.length > 0) {
      return parsed.errors.map((e) => e.message).join('; ')
    }
  } catch {
    // not JSON; fall through to raw text
  }
  return bodyText
}

/** Builds an OrchestratorError from a non-OK HTTP response (transport/auth/rate-limit failures). */
export async function mapHttpErrorResponse(response: Response): Promise<OrchestratorError> {
  const bodyText = await response.text().catch(() => '')
  const message =
    describeErrorBody(bodyText) ?? `Linear API error: ${response.status} ${response.statusText}`

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers)
    return new OrchestratorError(message, 'rate-limit', {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }
  if (response.status === 401 || response.status === 403) {
    return new OrchestratorError(message, 'auth-expired', { retryable: false })
  }
  if (response.status >= 500) {
    return new OrchestratorError(message, 'provider-outage', { retryable: true })
  }
  return new OrchestratorError(message, 'invalid-input', { retryable: false })
}

const AUTH_ERROR_PATTERN = /auth|unauthorized|unauthenticated|forbidden|api key/i

/** Builds an OrchestratorError from a 200 OK response whose body carries a GraphQL `errors` array. */
export function mapGraphQLErrors(errors: readonly GraphQLError[]): OrchestratorError {
  const message = errors.map((e) => e.message).join('; ')
  const isAuthError = errors.some(
    (e) => e.extensions?.code === 'AUTHENTICATION_ERROR' || AUTH_ERROR_PATTERN.test(e.message),
  )
  if (isAuthError) {
    return new OrchestratorError(message, 'auth-expired', { retryable: false })
  }
  return new OrchestratorError(message, 'invalid-input', { retryable: false })
}

/** Maps a fetch()-level rejection (network failure, DNS, TLS, ...) to a network error. */
export function mapNetworkError(error: unknown): OrchestratorError {
  return new OrchestratorError(error instanceof Error ? error.message : String(error), 'network', {
    retryable: true,
    cause: error,
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
