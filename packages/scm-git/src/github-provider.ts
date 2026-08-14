/**
 * GitHubSourceControlProvider: composes GitSourceControlProvider (all
 * plumbing-level git operations) and adds PR creation via the `gh` CLI.
 *
 * The `gh` invocation is behind an injectable `runner` so tests can assert on
 * the exact argv without ever shelling out to a real `gh` process.
 */

import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ProviderAvailability,
  ProviderInfo,
  PullRequestInfo,
  PullRequestRequest,
} from '@overture/core'
import { type ExecResult, execFileSafe } from './exec.js'
import { GitSourceControlProvider, type GitSourceControlProviderOptions } from './git-provider.js'
import { assertNoAttributionContent } from './policy.js'

export type GhRunner = (
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> },
) => Promise<ExecResult>

export interface GitHubSourceControlProviderOptions extends GitSourceControlProviderOptions {
  readonly ghBinary?: string
  /** Injectable for tests; defaults to invoking the real `gh` binary via execFile. */
  readonly runner?: GhRunner
}

export class GitHubSourceControlProvider extends GitSourceControlProvider {
  override readonly info: ProviderInfo = {
    id: 'github',
    displayName: 'GitHub',
    kind: 'scm',
    consumption: 'free',
    authentication: ['cli-session'],
  }

  private readonly ghBinary: string
  private readonly runner: GhRunner

  constructor(options: GitHubSourceControlProviderOptions = {}) {
    super(options)
    this.ghBinary = options.ghBinary ?? 'gh'
    this.runner =
      options.runner ?? ((args, runOptions) => execFileSafe(this.ghBinary, args, runOptions))
  }

  override async detect(): Promise<ProviderAvailability> {
    const gitAvailability = await super.detect()
    if (!gitAvailability.available) return gitAvailability

    try {
      await this.runner(['auth', 'status'], {})
      return {
        installed: true,
        authenticated: true,
        available: true,
        authenticationKind: 'cli-session',
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        installed: true,
        authenticated: false,
        available: false,
        authenticationKind: 'cli-session',
        detail,
      }
    }
  }

  async createPullRequest(request: PullRequestRequest): Promise<PullRequestInfo> {
    assertNoAttributionContent(request.title, 'Pull request title')
    assertNoAttributionContent(request.body, 'Pull request body')

    const bodyFile = join(tmpdir(), `overture-pr-body-${randomUUID()}.md`)
    await writeFile(bodyFile, request.body, 'utf8')
    try {
      const args = [
        'pr',
        'create',
        '--title',
        request.title,
        '--body-file',
        bodyFile,
        '--base',
        request.targetBranch,
        '--head',
        request.sourceBranch,
        '--repo',
        request.repository.locator,
      ]
      if (request.draft) args.push('--draft')

      const { stdout } = await this.runner(args, {})
      return parsePullRequestCreateOutput(stdout, request)
    } finally {
      await rm(bodyFile, { force: true })
    }
  }
}

function parsePullRequestCreateOutput(
  stdout: string,
  request: PullRequestRequest,
): PullRequestInfo {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const url = lines.at(-1) ?? ''
  const match = /\/pull\/(\d+)/.exec(url)
  const number = match?.[1] !== undefined ? Number(match[1]) : undefined
  return {
    id: url || `${request.repository.locator}#pending`,
    url,
    ...(number !== undefined ? { number } : {}),
  }
}
