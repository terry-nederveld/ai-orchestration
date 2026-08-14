/**
 * Maps raw fetch/HTTP failures and GraphQL business errors onto the shared
 * OrchestratorError taxonomy so orchestration code never has to branch on
 * GitHub-specific status codes or GraphQL error types.
 */

import { OrchestratorError } from '@overture/core'

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds * 1000
  const dateMs = Date.parse(raw)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

/** Falls back to `x-ratelimit-reset` (epoch seconds) when there's no Retry-After header. */
function parseRateLimitResetMs(headers: Headers): number | undefined {
  const reset = headers.get('x-ratelimit-reset')
  if (!reset) return undefined
  const resetSeconds = Number(reset)
  if (!Number.isFinite(resetSeconds)) return undefined
  return Math.max(0, resetSeconds * 1000 - Date.now())
}

/**
 * GitHub signals both primary rate limits (403/429 with `x-ratelimit-remaining: 0`)
 * and secondary/abuse rate limits (403 with a `retry-after` header) this way.
 */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true
  if (response.status === 403) {
    if (response.headers.get('x-ratelimit-remaining') === '0') return true
    if (response.headers.get('retry-after')) return true
  }
  return false
}

function describeErrorBody(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // not JSON; fall through to raw text
  }
  return bodyText
}

/** Builds an OrchestratorError from a non-OK GitHub REST or GraphQL-transport HTTP response. */
export async function mapHttpErrorResponse(response: Response): Promise<OrchestratorError> {
  const bodyText = await response.text().catch(() => '')
  const message =
    describeErrorBody(bodyText) ?? `GitHub API error: ${response.status} ${response.statusText}`

  if (isRateLimited(response)) {
    const retryAfterMs =
      parseRetryAfterMs(response.headers) ?? parseRateLimitResetMs(response.headers)
    return new OrchestratorError(message, 'rate-limit', {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }
  if (response.status === 401) {
    return new OrchestratorError(message, 'auth-expired', { retryable: false })
  }
  if (response.status >= 500) {
    return new OrchestratorError(message, 'provider-outage', { retryable: true })
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

export interface GraphQLErrorEntry {
  readonly message: string
  readonly type?: string
  readonly extensions?: { readonly code?: string }
}

/** Maps a GraphQL response's top-level `errors` array (HTTP 200 with a business-logic failure). */
export function mapGraphQLErrors(errors: readonly GraphQLErrorEntry[]): OrchestratorError {
  const message = errors.map((e) => e.message).join('; ') || 'GitHub GraphQL request failed'
  const codes = errors.map((e) => e.type ?? e.extensions?.code)

  if (codes.some((c) => c === 'RATE_LIMITED')) {
    return new OrchestratorError(message, 'rate-limit', { retryable: true })
  }
  if (codes.some((c) => c === 'FORBIDDEN' || c === 'UNAUTHORIZED' || c === 'INSUFFICIENT_SCOPES')) {
    return new OrchestratorError(message, 'auth-expired', { retryable: false })
  }
  return new OrchestratorError(message, 'invalid-input', { retryable: false })
}
