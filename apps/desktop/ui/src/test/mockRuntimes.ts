/**
 * Test doubles for federated runtimes: a global fetch stub that routes
 * requests by port to per-runtime handlers, so tests can stand up N fake
 * control planes (including unreachable ones) without a network.
 */
import { vi } from 'vitest'
import type { ConnectionEntry } from '../api/connection'

export type RouteResult = unknown | { readonly __status: number; readonly body: unknown }

export interface FakeRuntime {
  readonly port: number
  /** Pathname → handler; a missing path responds 404. */
  readonly routes: Record<string, (url: URL, init?: RequestInit) => RouteResult>
  /** When true every request rejects, as if the runtime were down. */
  fail?: boolean
}

export function withStatus(status: number, body: unknown): RouteResult {
  return { __status: status, body }
}

export function entry(
  name: string,
  port: number,
  kind: 'local' | 'remote' = 'local',
): ConnectionEntry {
  return { name, host: '127.0.0.1', port, token: `token-${name}`, kind }
}

/** Minimal /api/status payload; every reachable runtime needs one. */
export function statusPayload(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    version: '0.0.0-test',
    startedAt: new Date().toISOString(),
    activeRuns: 0,
    workSources: [],
    workflows: [],
    ...overrides,
  }
}

export function installFetchMock(runtimes: readonly FakeRuntime[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      const runtime = runtimes.find((candidate) => String(candidate.port) === url.port)
      if (!runtime || runtime.fail) {
        throw new TypeError(`fetch failed: ${url.host} unreachable`)
      }
      const handler = runtime.routes[url.pathname]
      if (!handler) {
        return jsonResponse(404, { error: `no route for ${url.pathname}` })
      }
      const result = handler(url, init)
      if (result !== null && typeof result === 'object' && '__status' in result) {
        const { __status, body } = result as { __status: number; body: unknown }
        return jsonResponse(__status, body)
      }
      return jsonResponse(200, result)
    }),
  )
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
