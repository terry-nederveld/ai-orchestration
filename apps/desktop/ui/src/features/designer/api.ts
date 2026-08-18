/**
 * Designer calls against the daemon's definition and evaluate endpoints.
 * Kept beside the feature (rather than in the shared ApiClient) so the
 * designer stays additive; it consumes the client's connection only.
 */

import { type ApiClient, ApiError } from '../../api/client'
import type {
  DefinitionLifecycle,
  EvaluateRequestBody,
  EvaluationReportView,
  GraphIssue,
  WorkflowDefinitionDetail,
  WorkflowDefinitionStatus,
  WorkflowGraphDoc,
} from './types'

async function request<T>(
  client: ApiClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${client.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  try {
    response = await fetch(new URL(path, client.baseUrl), init)
  } catch {
    throw new ApiError(`could not reach the daemon at ${client.baseUrl}`, 0, path)
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const payload = (await response.json()) as { error?: string }
      if (payload && typeof payload.error === 'string') message = payload.error
    } catch {
      // keep the status text
    }
    throw new ApiError(message, response.status, path)
  }
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export function listWorkflowDefinitions(
  client: ApiClient,
): Promise<readonly WorkflowDefinitionStatus[]> {
  return request(client, 'GET', '/api/definitions?kind=workflow')
}

export function getWorkflowDefinition(
  client: ApiClient,
  name: string,
  version?: number,
): Promise<WorkflowDefinitionDetail> {
  const query = version !== undefined ? `?version=${version}` : ''
  return request(client, 'GET', `/api/definitions/workflow/${encodeURIComponent(name)}${query}`)
}

/** Content-addressed: an unchanged document returns the existing version. */
export function saveWorkflowDefinition(
  client: ApiClient,
  name: string,
  document: WorkflowGraphDoc,
): Promise<{ readonly version: number }> {
  return request(client, 'PUT', `/api/definitions/workflow/${encodeURIComponent(name)}`, document)
}

export function setWorkflowLifecycle(
  client: ApiClient,
  name: string,
  lifecycle: DefinitionLifecycle,
): Promise<WorkflowDefinitionStatus> {
  return request(
    client,
    'POST',
    `/api/definitions/workflow/${encodeURIComponent(name)}/lifecycle`,
    {
      lifecycle,
    },
  )
}

export async function validateWorkflowDocument(
  client: ApiClient,
  document: WorkflowGraphDoc,
): Promise<readonly GraphIssue[]> {
  const result = await request<{ readonly issues: readonly GraphIssue[] }>(
    client,
    'POST',
    '/api/definitions/validate',
    { kind: 'workflow', document },
  )
  return result.issues
}

export function evaluateWorkflow(
  client: ApiClient,
  body: EvaluateRequestBody,
): Promise<EvaluationReportView> {
  return request(client, 'POST', '/api/evaluate', body)
}
