/**
 * Loopback HTTP control plane. Thin transport over OvertureService: JSON
 * request/response, bearer-token auth, and SSE for the live event stream.
 * Binds to 127.0.0.1 only.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Logger } from '@overture/core'
import { noopLogger } from '@overture/core'
import type { OvertureService } from './service.js'
import { parseDefinitionKind, parseDefinitionLifecycle, parseWaitKind } from './service.js'

export interface ControlPlaneOptions {
  readonly host?: string
  readonly port?: number
  /** Bearer token required on every request. Generated when omitted. */
  readonly token?: string
  readonly logger?: Logger
}

export interface ControlPlaneHandle {
  readonly port: number
  readonly host: string
  readonly token: string
  close(): Promise<void>
}

export async function startControlPlane(
  service: OvertureService,
  options: ControlPlaneOptions = {},
): Promise<ControlPlaneHandle> {
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(24).toString('hex')
  const logger = options.logger ?? noopLogger

  const server = createServer((request, response) => {
    void route(service, token, request, response).catch((error) => {
      logger.error('request failed', {
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : 'internal' })
      } else {
        response.end()
      }
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolvePromise())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)

  return {
    port,
    host,
    token,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}

async function route(
  service: OvertureService,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const method = request.method ?? 'GET'
  const path = url.pathname

  if (!authorized(request, token)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }

  if (method === 'GET' && path === '/api/status') {
    sendJson(response, 200, await service.status())
    return
  }

  if (method === 'GET' && path === '/api/runs') {
    const states = url.searchParams.getAll('state')
    const limit = url.searchParams.get('limit')
    sendJson(
      response,
      200,
      await service.listRuns({
        ...(states.length > 0 ? { states } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    )
    return
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/)
  if (method === 'GET' && runMatch?.[1]) {
    const runId = decodeId(runMatch[1])
    if (!runId) {
      sendJson(response, 400, { error: 'invalid run id' })
      return
    }
    const run = await service.getRun(runId)
    if (!run) sendJson(response, 404, { error: 'run not found' })
    else sendJson(response, 200, run)
    return
  }

  const runEventsMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (method === 'GET' && runEventsMatch?.[1]) {
    const after = url.searchParams.get('after') ?? undefined
    const runId = decodeId(runEventsMatch[1])
    if (!runId) {
      sendJson(response, 400, { error: 'invalid run id' })
      return
    }
    sendJson(response, 200, await service.runEvents(runId, after))
    return
  }

  const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (method === 'POST' && cancelMatch?.[1]) {
    const cancelId = decodeId(cancelMatch[1])
    if (!cancelId) {
      sendJson(response, 400, { error: 'invalid run id' })
      return
    }
    const cancelled = await service.cancelRun(cancelId)
    sendJson(response, cancelled ? 200 : 409, { cancelled })
    return
  }

  const retryMatch = path.match(/^\/api\/runs\/([^/]+)\/retry$/)
  if (method === 'POST' && retryMatch?.[1]) {
    const retryId = decodeId(retryMatch[1])
    if (!retryId) {
      sendJson(response, 400, { error: 'invalid run id' })
      return
    }
    sendJson(response, 200, await service.retryRun(retryId))
    return
  }

  if (method === 'POST' && path === '/api/runs') {
    const body = await readJson(request)
    const workItem = stringField(body, 'workItem')
    if (!workItem) {
      sendJson(response, 400, { error: 'workItem is required' })
      return
    }
    sendJson(response, 201, await service.triggerRun(workItem, stringField(body, 'workflow')))
    return
  }

  if (method === 'GET' && path === '/api/workflows') {
    sendJson(response, 200, await service.listWorkflows())
    return
  }

  if (method === 'POST' && path === '/api/workflows/validate') {
    const body = await readJson(request)
    const source = stringField(body, 'source')
    if (source === undefined) {
      sendJson(response, 400, { error: 'source is required' })
      return
    }
    sendJson(response, 200, service.validateWorkflowYaml(source))
    return
  }

  if (method === 'GET' && path === '/api/providers') {
    sendJson(response, 200, await service.listProviders())
    return
  }

  const workMatch = path.match(/^\/api\/work\/([^/]+)\/items$/)
  if (method === 'GET' && workMatch?.[1]) {
    const states = url.searchParams.getAll('state')
    sendJson(
      response,
      200,
      await service.listWorkItems(decodeId(workMatch[1]) ?? '', {
        ...(states.length > 0 ? { states } : {}),
      }),
    )
    return
  }

  if (method === 'GET' && path === '/api/approvals') {
    sendJson(response, 200, service.listApprovals())
    return
  }

  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (method === 'POST' && approvalMatch?.[1]) {
    const body = await readJson(request)
    const approved =
      body !== null && typeof body === 'object' && 'approved' in body
        ? Boolean((body as Record<string, unknown>).approved)
        : false
    const approvalId = decodeId(approvalMatch[1])
    if (!approvalId) {
      sendJson(response, 404, { error: 'invalid approval id' })
      return
    }
    const resolved = service.resolveApproval(approvalId, approved)
    sendJson(response, resolved ? 200 : 404, { resolved })
    return
  }

  if (method === 'GET' && path === '/api/usage') {
    const start = url.searchParams.get('start')
    const end = url.searchParams.get('end')
    const now = new Date()
    const periodStart = start ? new Date(start) : new Date(now.getTime() - 30 * 86_400_000)
    const periodEnd = end ? new Date(end) : now
    sendJson(response, 200, await service.usageTotals(periodStart, periodEnd))
    return
  }

  if (method === 'GET' && path === '/api/waits') {
    const runId = url.searchParams.get('runId')
    const type = url.searchParams.get('type')
    const reason = url.searchParams.get('reason')
    const kind = type ? parseWaitKind(type) : undefined
    if (type && !kind) {
      sendJson(response, 400, { error: `unknown wait type '${type}'` })
      return
    }
    sendJson(
      response,
      200,
      await service.listWaits({
        ...(runId ? { runId } : {}),
        ...(kind ? { kind } : {}),
        ...(reason ? { reason } : {}),
      }),
    )
    return
  }

  const waitRespondMatch = path.match(/^\/api\/waits\/([^/]+)\/respond$/)
  if (method === 'POST' && waitRespondMatch?.[1]) {
    const waitId = decodeId(waitRespondMatch[1])
    if (!waitId) {
      sendJson(response, 400, { error: 'invalid wait id' })
      return
    }
    const body = await readJson(request)
    if (body === null || typeof body !== 'object' || !('value' in body)) {
      sendJson(response, 400, { error: 'value is required' })
      return
    }
    const respondedBy = stringField(body, 'respondedBy')
    const result = await service.respondToWait(waitId, {
      value: (body as Record<string, unknown>).value,
      ...(respondedBy ? { respondedBy } : {}),
    })
    switch (result.outcome) {
      case 'accepted':
        sendJson(response, 200, { accepted: true })
        return
      case 'not-found':
        sendJson(response, 404, { error: 'wait not found' })
        return
      case 'invalid':
        sendJson(response, 400, { error: result.reason })
        return
      case 'unavailable':
        sendJson(response, 503, { error: 'graph runtime is not available in this daemon' })
        return
      default:
        sendJson(response, 409, {
          accepted: false,
          error: result.reason,
          ...(result.winner ? { winner: result.winner } : {}),
        })
        return
    }
  }

  if (method === 'GET' && path === '/api/definitions') {
    const rawKind = url.searchParams.get('kind')
    const kind = rawKind ? parseDefinitionKind(rawKind) : undefined
    if (rawKind && !kind) {
      sendJson(response, 400, { error: `unknown definition kind '${rawKind}'` })
      return
    }
    sendJson(response, 200, await service.listDefinitions(kind))
    return
  }

  if (method === 'POST' && path === '/api/definitions/validate') {
    const body = await readJson(request)
    const rawKind = stringField(body, 'kind')
    const kind = parseDefinitionKind(rawKind ?? '')
    if (!kind) {
      sendJson(response, 400, { error: `unknown definition kind '${rawKind ?? ''}'` })
      return
    }
    const document = objectField(body, 'document')
    if (!document) {
      sendJson(response, 400, { error: 'document must be an object' })
      return
    }
    sendJson(response, 200, { issues: service.validateDefinitionDocument(kind, document) })
    return
  }

  if (method === 'POST' && path === '/api/evaluate') {
    const body = await readJson(request)
    const workflowName = stringField(body, 'workflowName')
    if (!workflowName) {
      sendJson(response, 400, { error: 'workflowName is required' })
      return
    }
    const record = body as Record<string, unknown>
    const version = record.version
    if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
      sendJson(response, 400, { error: 'invalid version' })
      return
    }
    const itemExternalId = stringField(body, 'itemExternalId')
    const item = objectField(body, 'item')
    const variables = objectField(body, 'variables')
    const hypotheticalOutputs = objectField(body, 'hypotheticalOutputs')
    const result = await service.evaluate({
      workflowName,
      ...(version !== undefined ? { version: version as number } : {}),
      ...(itemExternalId !== undefined ? { itemExternalId } : {}),
      ...(item !== undefined ? { item } : {}),
      ...(variables !== undefined ? { variables } : {}),
      ...(hypotheticalOutputs !== undefined
        ? {
            hypotheticalOutputs: hypotheticalOutputs as Readonly<
              Record<string, Readonly<Record<string, unknown>>>
            >,
          }
        : {}),
    })
    switch (result.outcome) {
      case 'ok':
        sendJson(response, 200, result.report)
        return
      case 'unavailable':
        sendJson(response, 503, { error: result.reason })
        return
      case 'not-found':
        sendJson(response, 404, { error: result.reason })
        return
      default:
        sendJson(response, 400, { error: result.reason })
        return
    }
  }

  const lifecycleMatch = path.match(/^\/api\/definitions\/([^/]+)\/([^/]+)\/lifecycle$/)
  if (method === 'POST' && lifecycleMatch?.[1] && lifecycleMatch[2]) {
    const kind = parseDefinitionKind(decodeId(lifecycleMatch[1]) ?? '')
    const name = decodeId(lifecycleMatch[2])
    if (!kind || !name) {
      sendJson(response, 400, { error: 'invalid definition reference' })
      return
    }
    const body = await readJson(request)
    const lifecycle = parseDefinitionLifecycle(stringField(body, 'lifecycle') ?? '')
    if (!lifecycle) {
      sendJson(response, 400, { error: 'lifecycle must be draft, enabled, or disabled' })
      return
    }
    const status = await service.setDefinitionLifecycle(kind, name, lifecycle)
    if (!status) sendJson(response, 404, { error: 'definition not found' })
    else sendJson(response, 200, status)
    return
  }

  const definitionMatch = path.match(/^\/api\/definitions\/([^/]+)\/([^/]+)$/)
  if ((method === 'GET' || method === 'PUT') && definitionMatch?.[1] && definitionMatch[2]) {
    const kind = parseDefinitionKind(decodeId(definitionMatch[1]) ?? '')
    const name = decodeId(definitionMatch[2])
    if (!kind || !name) {
      sendJson(response, 400, { error: 'invalid definition reference' })
      return
    }
    if (method === 'GET') {
      const rawVersion = url.searchParams.get('version')
      const version = rawVersion ? Number(rawVersion) : undefined
      if (rawVersion && (!Number.isInteger(version) || (version as number) < 1)) {
        sendJson(response, 400, { error: 'invalid version' })
        return
      }
      const detail = await service.getDefinition(kind, name, version)
      if (!detail) sendJson(response, 404, { error: 'definition not found' })
      else sendJson(response, 200, detail)
      return
    }
    const body = await readJson(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'document body is required' })
      return
    }
    sendJson(
      response,
      201,
      await service.saveDefinition(kind, name, body as Record<string, unknown>),
    )
    return
  }

  if (method === 'GET' && path === '/api/judgments') {
    const since = url.searchParams.get('since')
    const until = url.searchParams.get('until')
    const now = new Date()
    const start = since ? new Date(since) : new Date(now.getTime() - 30 * 86_400_000)
    // listForPeriod is half-open [start, end); nudge past `now` so outcomes
    // recorded this instant are included.
    const end = until ? new Date(until) : new Date(now.getTime() + 1000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      sendJson(response, 400, { error: 'invalid since/until timestamp' })
      return
    }
    sendJson(response, 200, await service.listJudgments(start, end))
    return
  }

  const graphRunMatch = path.match(/^\/api\/graph-runs\/([^/]+)$/)
  if (method === 'GET' && graphRunMatch?.[1]) {
    const graphRunId = decodeId(graphRunMatch[1])
    if (!graphRunId) {
      sendJson(response, 400, { error: 'invalid run id' })
      return
    }
    const view = await service.getGraphRun(graphRunId)
    if (!view) sendJson(response, 404, { error: 'graph run not found' })
    else sendJson(response, 200, view)
    return
  }

  if (method === 'GET' && path === '/api/events') {
    streamEvents(service, url, request, response)
    return
  }

  sendJson(response, 404, { error: `no route for ${method} ${path}` })
}

function streamEvents(
  service: OvertureService,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write(':ok\n\n')
  const runId = url.searchParams.get('runId') ?? undefined
  const unsubscribe = service.subscribe((event) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }, runId)
  const keepAlive = setInterval(() => response.write(':keep-alive\n\n'), 25_000)
  keepAlive.unref?.()
  request.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

function tokensMatch(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ') && tokensMatch(header.slice(7), token)) return true
  // EventSource cannot set headers; allow the token as a query parameter for
  // the SSE endpoint only. The token is still required.
  if (request.url) {
    const url = new URL(request.url, 'http://localhost')
    if (
      url.pathname === '/api/events' &&
      tokensMatch(url.searchParams.get('token') ?? undefined, token)
    ) {
      return true
    }
  }
  return false
}

const SAFE_ID = /^[A-Za-z0-9._:#-]+$/

function decodeId(raw: string): string | undefined {
  const decoded = decodeURIComponent(raw)
  return SAFE_ID.test(decoded) ? decoded : undefined
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function stringField(body: unknown, field: string): string | undefined {
  if (body !== null && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

function objectField(body: unknown, field: string): Readonly<Record<string, unknown>> | undefined {
  if (body !== null && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
