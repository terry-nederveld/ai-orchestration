/**
 * Typed fetch wrapper over the Overture daemon's loopback HTTP API. See
 * `packages/server/src/http.ts` for the authoritative route contract.
 */
import type {
  OrchestratorEvent,
  PendingApproval,
  ProviderStatus,
  Run,
  ServiceStatus,
  UsageRecord,
  WorkflowDefinition,
  WorkflowValidationResult,
  WorkItem,
} from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface DaemonConnection {
  readonly baseUrl: string
  readonly token: string
}

export class ApiClient {
  constructor(private readonly connection: DaemonConnection) {}

  get baseUrl(): string {
    return this.connection.baseUrl
  }

  get token(): string {
    return this.connection.token
  }

  /** URL for the raw SSE stream; EventSource cannot set an Authorization header. */
  eventsUrl(runId?: string): string {
    const url = new URL('/api/events', this.connection.baseUrl)
    url.searchParams.set('token', this.connection.token)
    if (runId) url.searchParams.set('runId', runId)
    return url.toString()
  }

  status(): Promise<ServiceStatus> {
    return this.request<ServiceStatus>('GET', '/api/status')
  }

  listRuns(filter?: { states?: readonly string[]; limit?: number }): Promise<readonly Run[]> {
    const params = new URLSearchParams()
    for (const state of filter?.states ?? []) params.append('state', state)
    if (filter?.limit) params.set('limit', String(filter.limit))
    const query = params.toString()
    return this.request<readonly Run[]>('GET', `/api/runs${query ? `?${query}` : ''}`)
  }

  getRun(id: string): Promise<Run> {
    return this.request<Run>('GET', `/api/runs/${encodeURIComponent(id)}`)
  }

  getRunEvents(id: string, after?: string): Promise<readonly OrchestratorEvent[]> {
    const query = after ? `?after=${encodeURIComponent(after)}` : ''
    return this.request<readonly OrchestratorEvent[]>(
      'GET',
      `/api/runs/${encodeURIComponent(id)}/events${query}`,
    )
  }

  cancelRun(id: string): Promise<{ cancelled: boolean }> {
    return this.request('POST', `/api/runs/${encodeURIComponent(id)}/cancel`)
  }

  retryRun(id: string): Promise<Run> {
    return this.request<Run>('POST', `/api/runs/${encodeURIComponent(id)}/retry`)
  }

  createRun(workItem: string, workflow?: string): Promise<Run> {
    return this.request<Run>('POST', '/api/runs', { workItem, workflow })
  }

  listWorkflows(): Promise<readonly WorkflowDefinition[]> {
    return this.request<readonly WorkflowDefinition[]>('GET', '/api/workflows')
  }

  validateWorkflow(source: string): Promise<WorkflowValidationResult> {
    return this.request<WorkflowValidationResult>('POST', '/api/workflows/validate', { source })
  }

  listProviders(): Promise<readonly ProviderStatus[]> {
    return this.request<readonly ProviderStatus[]>('GET', '/api/providers')
  }

  listWorkItems(
    sourceId: string,
    filter?: { states?: readonly string[] },
  ): Promise<readonly WorkItem[]> {
    const params = new URLSearchParams()
    for (const state of filter?.states ?? []) params.append('state', state)
    const query = params.toString()
    return this.request<readonly WorkItem[]>(
      'GET',
      `/api/work/${encodeURIComponent(sourceId)}/items${query ? `?${query}` : ''}`,
    )
  }

  listApprovals(): Promise<readonly PendingApproval[]> {
    return this.request<readonly PendingApproval[]>('GET', '/api/approvals')
  }

  resolveApproval(id: string, approved: boolean): Promise<{ resolved: boolean }> {
    return this.request('POST', `/api/approvals/${encodeURIComponent(id)}`, { approved })
  }

  listUsage(start?: Date, end?: Date): Promise<readonly UsageRecord[]> {
    const params = new URLSearchParams()
    if (start) params.set('start', start.toISOString())
    if (end) params.set('end', end.toISOString())
    const query = params.toString()
    return this.request<readonly UsageRecord[]>('GET', `/api/usage${query ? `?${query}` : ''}`)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    // Built conditionally, rather than `body: body !== undefined ? ... :
    // undefined`, because exactOptionalPropertyTypes rejects assigning
    // `undefined` to RequestInit's optional `body` — the key must be absent
    // entirely when there is no body.
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
    try {
      response = await fetch(new URL(path, this.connection.baseUrl), init)
    } catch {
      throw new ApiError(`could not reach the daemon at ${this.connection.baseUrl}`, 0, path)
    }
    if (!response.ok) {
      const message = await extractErrorMessage(response)
      throw new ApiError(message, response.status, path)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return text ? (JSON.parse(text) as T) : (undefined as T)
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (payload && typeof payload.error === 'string') return payload.error
  } catch {
    // fall through to status text
  }
  return `${response.status} ${response.statusText}`
}
