/**
 * GitSourceControlProvider: SourceControlProvider backed by the `git` CLI,
 * invoked exclusively via argument-array execFile (see exec.ts) so no
 * caller-controlled value (path, branch, message) can inject shell syntax.
 */

import type {
  CommitInfo,
  CommitOptions,
  DiffSummary,
  ProviderAvailability,
  ProviderInfo,
  RepoStatus,
  RepositoryReference,
  SourceControlProvider,
} from '@overture/core'
import { type ExecResult, execFileSafe } from './exec.js'
import { capPatch, parseNumstat, parsePorcelainV2Status } from './parse.js'
import { assertNoAttributionTrailers } from './policy.js'

export interface GitSourceControlProviderOptions {
  readonly gitBinary?: string
  readonly env?: Record<string, string>
}

export class GitSourceControlProvider implements SourceControlProvider {
  readonly info: ProviderInfo = {
    id: 'git',
    displayName: 'Git',
    kind: 'scm',
    consumption: 'free',
    authentication: ['none'],
  }

  protected readonly gitBinary: string
  protected readonly baseEnv: Record<string, string> | undefined

  constructor(options: GitSourceControlProviderOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git'
    this.baseEnv = options.env
  }

  protected git(
    args: readonly string[],
    cwd?: string,
    extraEnv?: Record<string, string>,
  ): Promise<ExecResult> {
    const env = this.baseEnv || extraEnv ? { ...this.baseEnv, ...extraEnv } : undefined
    return execFileSafe(this.gitBinary, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    })
  }

  async detect(): Promise<ProviderAvailability> {
    try {
      const { stdout } = await this.git(['--version'])
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: 'none',
        detail: stdout.trim(),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        installed: false,
        authenticated: false,
        available: false,
        authenticationKind: 'none',
        detail,
      }
    }
  }

  async clone(repository: RepositoryReference, destination: string): Promise<void> {
    await this.git(['clone', repository.locator, destination])
  }

  async fetch(workdir: string): Promise<void> {
    await this.git(['fetch', '--all', '--prune'], workdir)
  }

  async createBranch(workdir: string, name: string, baseRef?: string): Promise<void> {
    const args = ['checkout', '-b', name]
    if (baseRef !== undefined) args.push(baseRef)
    await this.git(args, workdir)
  }

  async status(workdir: string): Promise<RepoStatus> {
    const { stdout } = await this.git(['status', '--porcelain=v2', '--branch'], workdir)
    return parsePorcelainV2Status(stdout)
  }

  async diff(workdir: string, baseRef?: string): Promise<DiffSummary> {
    const target = baseRef ?? 'HEAD'
    const { stdout: numstat } = await this.git(['diff', '--numstat', target], workdir)
    const { filesChanged, insertions, deletions } = parseNumstat(numstat)
    const { stdout: patch } = await this.git(['diff', target], workdir)
    return { filesChanged, insertions, deletions, patch: capPatch(patch) }
  }

  async commit(workdir: string, options: CommitOptions): Promise<CommitInfo> {
    assertNoAttributionTrailers(options.message)

    if (options.paths && options.paths.length > 0) {
      await this.git(['add', '--', ...options.paths], workdir)
    } else {
      await this.git(['add', '-A'], workdir)
    }

    const commitEnv: Record<string, string> = {}
    if (options.authorName !== undefined) {
      commitEnv.GIT_AUTHOR_NAME = options.authorName
      commitEnv.GIT_COMMITTER_NAME = options.authorName
    }
    if (options.authorEmail !== undefined) {
      commitEnv.GIT_AUTHOR_EMAIL = options.authorEmail
      commitEnv.GIT_COMMITTER_EMAIL = options.authorEmail
    }

    await this.git(['commit', '-m', options.message], workdir, commitEnv)
    const { stdout } = await this.git(['rev-parse', 'HEAD'], workdir, commitEnv)
    return { sha: stdout.trim(), message: options.message }
  }

  async push(workdir: string, branch: string): Promise<void> {
    await this.git(['push', '--set-upstream', 'origin', branch], workdir)
  }
}
