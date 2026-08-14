/**
 * Daemon client: locates the running daemon via the state directory and
 * speaks the control-plane HTTP API. All CLI commands (except local-only
 * secrets/config commands and `daemon` itself) go through this.
 */

import { defaultStateDir, isProcessAlive, readDaemonInfo } from '@overture/server'

export class DaemonUnavailableError extends Error {
  constructor() {
    super("the Overture daemon is not running — start it with 'overture daemon'")
    this.name = 'DaemonUnavailableError'
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface DaemonConnection {
  readonly baseUrl: string
  readonly token: string
}

export async function connect(stateDir = defaultStateDir()): Promise<DaemonConnection> {
  const info = await readDaemonInfo(stateDir)
  if (!info || !isProcessAlive(info.pid)) throw new DaemonUnavailableError()
  return { baseUrl: `http://${info.host}:${info.port}`, token: info.token }
}

export class DaemonClient {
  constructor(
    private readonly connection: DaemonConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.connection.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const message = typeof payload.error === 'string' ? payload.error : response.statusText
      throw new ApiError(response.status, message)
    }
    return payload as T
  }

  /** Follow the SSE event stream, invoking onEvent per parsed event. */
  async follow(
    onEvent: (event: Record<string, unknown>) => void,
    options: { runId?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    const params = new URLSearchParams({ token: this.connection.token })
    if (options.runId) params.set('runId', options.runId)
    const response = await this.fetchImpl(
      `${this.connection.baseUrl}/api/events?${params.toString()}`,
      { ...(options.signal ? { signal: options.signal } : {}) },
    )
    if (!response.ok || !response.body) throw new ApiError(response.status, 'event stream failed')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine) {
          try {
            onEvent(JSON.parse(dataLine.slice(6)))
          } catch {
            // Ignore malformed frames.
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  }
}
