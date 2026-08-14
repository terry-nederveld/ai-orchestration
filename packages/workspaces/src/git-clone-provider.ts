/**
 * GitCloneWorkspaceProvider: a fresh `git clone` per run under
 * workspacesRoot/<runId>, on a new branch. Fully isolated, at the cost of a
 * full clone per run (see GitWorktreeWorkspaceProvider for a cheaper
 * alternative that shares object storage via a single base clone).
 */

import { mkdir, rm } from 'node:fs/promises'
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
import type { GitSourceControlProvider } from '@overture/scm-git'
import { resolveInsideRoot, toSafeSlug } from './path-safety.js'
import { shouldDelete } from './retention.js'

export interface GitCloneWorkspaceProviderOptions {
  readonly workspacesRoot: string
  readonly scm: GitSourceControlProvider
}

export class GitCloneWorkspaceProvider implements WorkspaceProvider {
  readonly info: ProviderInfo = {
    id: 'git-clone',
    displayName: 'Git Clone Workspace',
    kind: 'workspace',
    consumption: 'free',
    authentication: ['none'],
  }
  readonly strategy: WorkspaceStrategy = 'git-clone'

  private readonly workspacesRoot: string
  private readonly scm: GitSourceControlProvider

  constructor(options: GitCloneWorkspaceProviderOptions) {
    this.workspacesRoot = resolve(options.workspacesRoot)
    this.scm = options.scm
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    if (!request.repository) {
      throw new OrchestratorError(
        'git-clone workspaces require a repository reference',
        'invalid-input',
      )
    }

    const path = resolveInsideRoot(this.workspacesRoot, request.runId)
    await mkdir(this.workspacesRoot, { recursive: true })
    await this.scm.clone(request.repository, path)

    const branch = request.branch ?? `overture/${toSafeSlug(request.runId)}`
    await this.scm.createBranch(path, branch, request.baseRef)

    return {
      id: asId(`ws-${request.runId}`),
      strategy: this.strategy,
      path,
      repository: request.repository,
      branch,
      createdAt: new Date(),
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
