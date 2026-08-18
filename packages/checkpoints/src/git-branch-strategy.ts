/**
 * GitBranchCheckpointStrategy: durable checkpoints for coding runs. Progress
 * is persisted by committing work-in-progress (only when the tree is dirty)
 * and pushing the run's branch to origin; restore rebuilds a fresh worktree
 * from the remote branch so a new session can continue where the last one
 * stopped, even on a different host.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  type Checkpoint,
  type CheckpointContext,
  type CheckpointStrategy,
  type Clock,
  OrchestratorError,
  type RunId,
  systemClock,
} from '@overture/core'
import {
  execFileSafe,
  type GitSourceControlProvider,
  type GitWorktreeManager,
} from '@overture/scm-git'

export interface GitBranchWorkspacesOptions {
  /** Shared base clones live under `<reposRoot>/<repo slug>`. */
  readonly reposRoot: string
  /** Restored worktrees live under `<workspacesRoot>/<runId>-r<N>`. */
  readonly workspacesRoot: string
  readonly worktrees: GitWorktreeManager
}

/**
 * Resolves the repository a run works against so restore() can rebuild from
 * coordinates alone. Injected port: the orchestrator knows the run -> repo
 * mapping; CheckpointContext deliberately does not carry it.
 */
export type RepositoryResolver = (runId: RunId) => Promise<{ readonly locator: string } | undefined>

export interface GitBranchCheckpointStrategyOptions {
  readonly scm: GitSourceControlProvider
  readonly workspaces: GitBranchWorkspacesOptions
  readonly resolveRepository: RepositoryResolver
  readonly clock?: Clock
}

/** Cap on the summary carried into the WIP commit subject line. */
const SUMMARY_LIMIT = 60

export class GitBranchCheckpointStrategy implements CheckpointStrategy {
  readonly id = 'git-branch'

  private readonly scm: GitSourceControlProvider
  private readonly reposRoot: string
  private readonly workspacesRoot: string
  private readonly worktrees: GitWorktreeManager
  private readonly resolveRepository: RepositoryResolver
  private readonly clock: Clock

  constructor(options: GitBranchCheckpointStrategyOptions) {
    this.scm = options.scm
    this.reposRoot = resolve(options.workspaces.reposRoot)
    this.workspacesRoot = resolve(options.workspaces.workspacesRoot)
    this.worktrees = options.workspaces.worktrees
    this.resolveRepository = options.resolveRepository
    this.clock = options.clock ?? systemClock
  }

  async checkpoint(context: CheckpointContext): Promise<Checkpoint> {
    const { workspacePath, branch } = context
    if (!workspacePath || !branch) {
      throw new OrchestratorError(
        'git-branch checkpoints require a workspacePath and branch',
        'invalid-input',
      )
    }

    const status = await this.scm.status(workspacePath)
    const dirty = !status.clean
    if (dirty) {
      await this.scm.commit(workspacePath, { message: checkpointCommitMessage(context.summary) })
    }
    if (dirty || (await this.hasUnpushedCommits(workspacePath, branch))) {
      await this.scm.push(workspacePath, branch)
    }

    const sha = await revParse(workspacePath, 'HEAD')
    const repository = await this.resolveRepository(context.runId)

    return {
      id: `cp-${randomUUID()}`,
      runId: context.runId,
      nodeId: context.nodeId,
      strategy: this.id,
      createdAt: this.clock.now(),
      coordinates: {
        branch,
        sha,
        remote: 'origin',
        ...(repository !== undefined ? { repository: repository.locator } : {}),
      },
      summary: context.summary,
      specRevision: context.specRevision,
    }
  }

  async restore(checkpoint: Checkpoint): Promise<Readonly<Record<string, unknown>>> {
    const branch = requireCoordinate(checkpoint, 'branch')
    const sha = requireCoordinate(checkpoint, 'sha')
    const locator = requireCoordinate(checkpoint, 'repository')

    const repoDir = await this.ensureBaseRepo(locator)
    const remoteRef = `origin/${branch}`
    const remoteSha = await revParse(repoDir, remoteRef).catch(() => {
      throw new OrchestratorError(
        `remote branch "${branch}" not found while restoring checkpoint ${checkpoint.id}`,
        'invalid-input',
      )
    })

    let note: string | undefined
    if (remoteSha !== sha) {
      if (!(await isAncestor(repoDir, sha, remoteSha))) {
        throw new OrchestratorError(
          `remote branch "${branch}" no longer contains checkpoint commit ${sha}`,
          'conflict',
        )
      }
      note = `remote branch advanced past checkpoint ${sha}; restored at remote head ${remoteSha}`
    }

    await mkdir(this.workspacesRoot, { recursive: true })
    const workspacePath = await this.freshWorktreePath(checkpoint.runId)
    await this.checkoutWorktree(repoDir, workspacePath, branch, remoteRef)

    const restoredSha = await revParse(workspacePath, 'HEAD')
    return {
      workspacePath,
      branch,
      sha: restoredSha,
      ...(note !== undefined ? { note } : {}),
    }
  }

  /** True when `branch` has commits origin doesn't (including a never-pushed branch). */
  private async hasUnpushedCommits(workdir: string, branch: string): Promise<boolean> {
    try {
      const { stdout } = await execFileSafe(
        'git',
        ['rev-list', '--count', `origin/${branch}..HEAD`],
        { cwd: workdir },
      )
      return Number.parseInt(stdout.trim(), 10) > 0
    } catch {
      return true
    }
  }

  /** Ensures the shared base clone exists, cloning it or refreshing its refs. */
  private async ensureBaseRepo(locator: string): Promise<string> {
    const repoDir = resolveInsideRoot(this.reposRoot, locator)
    if (await pathExists(join(repoDir, '.git'))) {
      await this.scm.fetch(repoDir)
    } else {
      await mkdir(this.reposRoot, { recursive: true })
      await this.scm.clone({ locator }, repoDir)
    }
    return repoDir
  }

  /** First `<workspacesRoot>/<runId>-r<N>` that doesn't already exist on disk. */
  private async freshWorktreePath(runId: RunId): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const candidate = resolveInsideRoot(this.workspacesRoot, `${runId}-r${attempt}`)
      if (!(await pathExists(candidate))) return candidate
    }
  }

  private async checkoutWorktree(
    repoDir: string,
    worktreePath: string,
    branch: string,
    remoteRef: string,
  ): Promise<void> {
    try {
      await this.worktrees.addWorktree(repoDir, worktreePath, branch, remoteRef)
    } catch {
      // The local branch already exists (an earlier restore created it, and
      // may even still have it checked out in a dead worktree): attach a
      // fresh worktree to it and fast-forward it to the remote head.
      await execFileSafe('git', ['worktree', 'add', '--force', worktreePath, branch], {
        cwd: repoDir,
      })
      await execFileSafe('git', ['merge', '--ff-only', remoteRef], { cwd: worktreePath })
    }
  }
}

function checkpointCommitMessage(summary: string): string {
  const trimmed = summary.trim().slice(0, SUMMARY_LIMIT).trim()
  return `chore(checkpoint): ${trimmed.length > 0 ? trimmed : 'work in progress'}`
}

function requireCoordinate(checkpoint: Checkpoint, key: string): string {
  const value = checkpoint.coordinates[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new OrchestratorError(
      `checkpoint ${checkpoint.id} is missing the "${key}" coordinate`,
      'invalid-input',
    )
  }
  return value
}

async function revParse(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileSafe('git', ['rev-parse', '--verify', ref], { cwd: dir })
  return stdout.trim()
}

async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileSafe('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: dir })
    return true
  } catch {
    return false
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

// Mirrors @overture/workspaces path-safety: caller-controlled values (run
// ids, repo locators) become safe slugs before joining, so they can never
// escape the configured root. Kept local so this package's runtime deps stay
// core + scm-git only.
const UNSAFE_CHARS = /[^a-zA-Z0-9._-]/g

function toSafeSlug(value: string): string {
  const slug = value
    .replace(UNSAFE_CHARS, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  if (slug.length === 0) {
    throw new OrchestratorError(
      `Cannot derive a safe path segment from "${value}"`,
      'invalid-input',
    )
  }
  return slug
}

function resolveInsideRoot(root: string, segment: string): string {
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, toSafeSlug(segment))
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new OrchestratorError(`Path "${target}" escapes root "${resolvedRoot}"`, 'policy')
  }
  return target
}
