/**
 * Workspace isolation contract. Each run executes in an isolated working
 * directory; strategies (worktree, clone, local dir, temp sandbox, future
 * containers/remote) are interchangeable implementations.
 */

import type { ProviderInfo } from './capabilities.js'
import type { RunId, WorkspaceId } from './ids.js'
import type { RepositoryReference } from './work.js'

export type WorkspaceStrategy = 'git-worktree' | 'git-clone' | 'local-directory' | 'temp-directory'

export interface WorkspaceRequest {
  readonly runId: RunId
  readonly repository?: RepositoryReference
  /** Branch to create/check out for the run's work, when applicable. */
  readonly branch?: string
  readonly baseRef?: string
  /** Existing directory to use (local-directory strategy only). */
  readonly path?: string
}

export interface Workspace {
  readonly id: WorkspaceId
  readonly strategy: WorkspaceStrategy
  readonly path: string
  readonly repository?: RepositoryReference
  readonly branch?: string
  readonly createdAt: Date
}

export type WorkspaceRetention = 'always' | 'on-failure' | 'never'

export interface WorkspaceProvider {
  readonly info: ProviderInfo
  readonly strategy: WorkspaceStrategy
  create(request: WorkspaceRequest): Promise<Workspace>
  /** Remove the workspace according to retention policy. Idempotent. */
  cleanup(workspace: Workspace, retention: WorkspaceRetention, failed: boolean): Promise<void>
}
