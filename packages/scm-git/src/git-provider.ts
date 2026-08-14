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
import { assertNoAttributionTrailers, assertNoAttributionTrailersInPushedCommit } from './policy.js'

export interface GitSourceControlProviderOptions {
  readonly gitBinary?: string
  readonly env?: Record<string, string>
  /**
   * Skips the pre-push attribution scan (see push()). Defaults to false —
   * every push is checked unless a caller explicitly opts out. This exists
   * for tests and exotic setups, not for routine use.
   */
  readonly skipAttributionCheckOnPush?: true
}

/** Record separator: safe to split on since it cannot appear in commit text. */
const RECORD_SEPARATOR = '\x1e'
/** Cap for the fallback full-branch-log scan (no remotes configured yet). */
const FALLBACK_LOG_LIMIT = 200

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
  private readonly skipAttributionCheckOnPush: boolean

  constructor(options: GitSourceControlProviderOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git'
    this.baseEnv = options.env
    this.skipAttributionCheckOnPush = options.skipAttributionCheckOnPush ?? false
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

    // Fresh clones and worktrees on machines without a global git identity
    // (CI runners, daemon hosts) would otherwise fail with "empty ident";
    // fall back to a neutral identity when none is configured or supplied.
    if (options.authorName === undefined || options.authorEmail === undefined) {
      const configured = await this.git(['config', 'user.email'], workdir, commitEnv).catch(() => ({
        stdout: '',
        stderr: '',
      }))
      if (configured.stdout.trim().length === 0) {
        commitEnv.GIT_AUTHOR_NAME ??= 'Overture'
        commitEnv.GIT_COMMITTER_NAME ??= 'Overture'
        commitEnv.GIT_AUTHOR_EMAIL ??= 'overture@localhost'
        commitEnv.GIT_COMMITTER_EMAIL ??= 'overture@localhost'
      }
    }

    await this.git(['commit', '-m', options.message], workdir, commitEnv)
    const { stdout } = await this.git(['rev-parse', 'HEAD'], workdir, commitEnv)
    return { sha: stdout.trim(), message: options.message }
  }

  async push(workdir: string, branch: string): Promise<void> {
    if (!this.skipAttributionCheckOnPush) {
      await this.assertNoAttributionInCommitsToPush(workdir, branch)
    }
    await this.git(['push', '--set-upstream', 'origin', branch], workdir)
  }

  /**
   * Validates every commit that would be pushed, not just commits made
   * through commit() — the delivery choke point is push(), since an agent
   * can also commit directly via a shell tool, bypassing commit()'s check
   * entirely (ATTRIB-BYPASS). Commits already on a remote-tracking ref are
   * excluded (they were already validated or already public); everything
   * else reachable from `branch` is scanned.
   */
  private async assertNoAttributionInCommitsToPush(workdir: string, branch: string): Promise<void> {
    for (const message of await this.commitsToPush(workdir, branch)) {
      assertNoAttributionTrailersInPushedCommit(message)
    }
  }

  private async commitsToPush(workdir: string, branch: string): Promise<string[]> {
    const format = `--format=%B${RECORD_SEPARATOR}`
    const primary = await this.git(['log', format, branch, '--not', '--remotes'], workdir)

    if (primary.stdout.trim().length === 0) {
      const { stdout: remotes } = await this.git(['remote'], workdir)
      const noRemotesConfigured = remotes.trim().length === 0
      if (noRemotesConfigured) {
        const fallback = await this.git(
          ['log', format, branch, '-n', String(FALLBACK_LOG_LIMIT)],
          workdir,
        )
        return splitCommitMessages(fallback.stdout)
      }
    }

    return splitCommitMessages(primary.stdout)
  }
}

function splitCommitMessages(output: string): string[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((message) => message.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((message) => message.length > 0)
}
