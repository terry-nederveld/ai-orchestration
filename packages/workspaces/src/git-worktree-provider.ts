/**
 * GitWorktreeWorkspaceProvider: one shared base clone per repository under
 * reposRoot, with a `git worktree` per run under workspacesRoot/<runId>.
 * Cheaper than a full clone per run (shared object storage) while still
 * giving each run an isolated working directory and branch.
 */

import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  asId,
  OrchestratorError,
  type ProviderInfo,
  type RepositoryReference,
  type Workspace,
  type WorkspaceProvider,
  type WorkspaceRequest,
  type WorkspaceRetention,
  type WorkspaceStrategy,
} from '@overture/core'
import {
  execFileSafe,
  type GitSourceControlProvider,
  type GitWorktreeManager,
} from '@overture/scm-git'
import { resolveInsideRoot, toSafeSlug } from './path-safety.js'
import { shouldDelete } from './retention.js'

export interface GitWorktreeWorkspaceProviderOptions {
  readonly reposRoot: string
  readonly workspacesRoot: string
  readonly scm: GitSourceControlProvider
  readonly worktrees: GitWorktreeManager
}

export class GitWorktreeWorkspaceProvider implements WorkspaceProvider {
  readonly info: ProviderInfo = {
    id: 'git-worktree',
    displayName: 'Git Worktree Workspace',
    kind: 'workspace',
    consumption: 'free',
    authentication: ['none'],
  }
  readonly strategy: WorkspaceStrategy = 'git-worktree'

  private readonly reposRoot: string
  private readonly workspacesRoot: string
  private readonly scm: GitSourceControlProvider
  private readonly worktrees: GitWorktreeManager
  /** Serializes clone/fetch per repo dir so concurrent creates never race on the same base repo. */
  private readonly repoLocks = new Map<string, Promise<string>>()

  constructor(options: GitWorktreeWorkspaceProviderOptions) {
    this.reposRoot = resolve(options.reposRoot)
    this.workspacesRoot = resolve(options.workspacesRoot)
    this.scm = options.scm
    this.worktrees = options.worktrees
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    if (!request.repository) {
      throw new OrchestratorError(
        'git-worktree workspaces require a repository reference',
        'invalid-input',
      )
    }
    const repository = request.repository

    const repoDir = await this.ensureBaseRepo(repository)
    const worktreePath = resolveInsideRoot(this.workspacesRoot, request.runId)
    const branch = request.branch ?? `overture/${toSafeSlug(request.runId)}`
    const baseRef = request.baseRef ?? (await this.resolveDefaultRef(repoDir, repository))

    await mkdir(this.workspacesRoot, { recursive: true })
    await this.worktrees.addWorktree(repoDir, worktreePath, branch, baseRef)

    return {
      id: asId(`ws-${request.runId}`),
      strategy: this.strategy,
      path: worktreePath,
      repository,
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

    const repoDir = workspace.repository ? this.repoDirFor(workspace.repository) : undefined
    if (repoDir && (await pathExists(repoDir))) {
      try {
        await this.worktrees.removeWorktree(repoDir, workspace.path, true)
        return
      } catch {
        // Worktree metadata may already be gone (e.g. repo dir cleaned up
        // separately); fall back to removing the directory directly.
      }
    }
    await rm(workspace.path, { recursive: true, force: true })
  }

  private repoDirFor(repository: RepositoryReference): string {
    return resolveInsideRoot(this.reposRoot, repository.locator)
  }

  /** Ensures the shared base clone exists (cloning or fetching), serialized per repo dir. */
  private async ensureBaseRepo(repository: RepositoryReference): Promise<string> {
    const repoDir = this.repoDirFor(repository)
    const previous = this.repoLocks.get(repoDir) ?? Promise.resolve(repoDir)
    const task = previous
      .catch(() => repoDir)
      .then(() => this.ensureBaseRepoUnlocked(repoDir, repository))
    this.repoLocks.set(repoDir, task)
    return task
  }

  private async ensureBaseRepoUnlocked(
    repoDir: string,
    repository: RepositoryReference,
  ): Promise<string> {
    if (await pathExists(join(repoDir, '.git'))) {
      await this.scm.fetch(repoDir)
    } else {
      await mkdir(this.reposRoot, { recursive: true })
      await this.scm.clone(repository, repoDir)
    }
    return repoDir
  }

  /** Default branch: configured default, else origin's remote HEAD, else local HEAD. */
  private async resolveDefaultRef(
    repoDir: string,
    repository: RepositoryReference,
  ): Promise<string> {
    if (repository.defaultBranch) return `origin/${repository.defaultBranch}`
    try {
      const { stdout } = await execFileSafe('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd: repoDir,
      })
      return stdout.trim().replace(/^refs\/remotes\//, '')
    } catch {
      return 'HEAD'
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
