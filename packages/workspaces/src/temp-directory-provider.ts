/**
 * TempDirectoryWorkspaceProvider: an mkdtemp sandbox with no repository
 * requirement. Useful for exploratory or non-code runs.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  asId,
  type ProviderInfo,
  type Workspace,
  type WorkspaceProvider,
  type WorkspaceRequest,
  type WorkspaceRetention,
  type WorkspaceStrategy,
} from '@overture/core'
import { toSafeSlug } from './path-safety.js'
import { shouldDelete } from './retention.js'

export interface TempDirectoryWorkspaceProviderOptions {
  readonly baseDir?: string
}

export class TempDirectoryWorkspaceProvider implements WorkspaceProvider {
  readonly info: ProviderInfo = {
    id: 'temp-directory',
    displayName: 'Temp Directory Workspace',
    kind: 'workspace',
    consumption: 'free',
    authentication: ['none'],
  }
  readonly strategy: WorkspaceStrategy = 'temp-directory'

  private readonly baseDir: string

  constructor(options: TempDirectoryWorkspaceProviderOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? tmpdir())
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    await mkdir(this.baseDir, { recursive: true })
    const prefix = join(this.baseDir, `overture-${toSafeSlug(request.runId)}-`)
    const path = await mkdtemp(prefix)
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
    workspace: Workspace,
    retention: WorkspaceRetention,
    failed: boolean,
  ): Promise<void> {
    if (!shouldDelete(retention, failed)) return
    await rm(workspace.path, { recursive: true, force: true })
  }
}
