/**
 * GitWorktreeManager: thin wrapper over `git worktree` for providers that
 * need multiple isolated working directories against a single repository
 * (e.g. one worktree per orchestrator run).
 */

import { type ExecResult, execFileSafe } from './exec.js'
import { parseWorktreeList, type WorktreeInfo } from './parse.js'

export interface GitWorktreeManagerOptions {
  readonly gitBinary?: string
  readonly env?: Record<string, string>
}

export class GitWorktreeManager {
  private readonly gitBinary: string
  private readonly env: Record<string, string> | undefined

  constructor(options: GitWorktreeManagerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git'
    this.env = options.env
  }

  private git(args: readonly string[], cwd: string): Promise<ExecResult> {
    return execFileSafe(this.gitBinary, args, {
      cwd,
      ...(this.env !== undefined ? { env: this.env } : {}),
    })
  }

  async addWorktree(
    repoDir: string,
    worktreePath: string,
    branch: string,
    baseRef?: string,
  ): Promise<void> {
    const args = ['worktree', 'add', '-b', branch, worktreePath]
    if (baseRef !== undefined) args.push(baseRef)
    await this.git(args, repoDir)
  }

  async removeWorktree(repoDir: string, worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove', worktreePath]
    if (force) args.push('--force')
    await this.git(args, repoDir)
  }

  async listWorktrees(repoDir: string): Promise<readonly WorktreeInfo[]> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoDir)
    return parseWorktreeList(stdout)
  }
}
