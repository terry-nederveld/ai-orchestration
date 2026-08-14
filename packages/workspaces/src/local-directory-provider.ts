/**
 * LocalDirectoryWorkspaceProvider: uses an existing directory as-is, with no
 * isolation. For advanced users who want the orchestrator to operate
 * directly on a working copy they manage themselves. cleanup() never
 * deletes — the directory does not belong to the orchestrator.
 *
 * Resolution order for the directory: `request.path`, then a supplied
 * `repository.locator` treated as a literal filesystem path, then the
 * configured `defaultPath`.
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  asId,
  OrchestratorError,
  type ProviderInfo,
  type Workspace,
  type WorkspaceProvider,
  type WorkspaceRequest,
  type WorkspaceRetention,
  type WorkspaceStrategy,
} from '@overture/core'

export interface LocalDirectoryWorkspaceProviderOptions {
  readonly defaultPath?: string
}

export class LocalDirectoryWorkspaceProvider implements WorkspaceProvider {
  readonly info: ProviderInfo = {
    id: 'local-directory',
    displayName: 'Local Directory Workspace',
    kind: 'workspace',
    consumption: 'free',
    authentication: ['none'],
  }
  readonly strategy: WorkspaceStrategy = 'local-directory'

  private readonly defaultPath: string | undefined

  constructor(options: LocalDirectoryWorkspaceProviderOptions = {}) {
    this.defaultPath = options.defaultPath
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    const rawPath = request.path ?? request.repository?.locator ?? this.defaultPath
    if (rawPath === undefined) {
      throw new OrchestratorError(
        'local-directory workspaces require request.path, request.repository.locator, or a configured defaultPath',
        'invalid-input',
      )
    }

    const path = resolve(rawPath)
    const exists = await directoryExists(path)
    if (!exists) {
      throw new OrchestratorError(`Local directory "${path}" does not exist`, 'invalid-input')
    }

    return {
      id: asId(`ws-${request.runId}`),
      strategy: this.strategy,
      path,
      createdAt: new Date(),
      ...(request.repository !== undefined ? { repository: request.repository } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    }
  }

  async cleanup(
    _workspace: Workspace,
    _retention: WorkspaceRetention,
    _failed: boolean,
  ): Promise<void> {
    // Never deletes: the directory is owned by the user, not the orchestrator.
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}
