/**
 * Maps raw fetch/HTTP failures onto the shared OrchestratorError taxonomy so
 * orchestration code never has to branch on OpenAI-specific status codes.
 * Shared by every OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, ...).
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

export async function mapHttpErrorResponse(response: Response): Promise<OrchestratorError> {
  const bodyText = await response.text().catch(() => '')
  const message =
    describeErrorBody(bodyText) ??
    `OpenAI-compatible API error: ${response.status} ${response.statusText}`

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

function describeErrorBody(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; type?: string } }
    if (parsed.error?.message) {
      return parsed.error.type
        ? `${parsed.error.type}: ${parsed.error.message}`
        : parsed.error.message
    }
  } catch {
    // not JSON; fall through to raw text
  }
  return bodyText
}

export function mapNetworkError(error: unknown): OrchestratorError {
  return new OrchestratorError(error instanceof Error ? error.message : String(error), 'network', {
    retryable: true,
    cause: error,
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}
