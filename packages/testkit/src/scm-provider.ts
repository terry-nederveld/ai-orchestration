/**
 * FakeSourceControlProvider: a no-op SourceControlProvider that tracks state
 * per workdir (current branch, commit history, dirty flag) so tests can drive
 * and assert on source-control behavior without touching real Git.
 */

import type {
  CommitInfo,
  CommitOptions,
  DiffSummary,
  ProviderAvailability,
  ProviderInfo,
  PullRequestInfo,
  PullRequestRequest,
  RepoStatus,
  RepositoryReference,
  SourceControlProvider,
} from '@overture/core'

export type ScmProviderCall =
  | { readonly op: 'clone'; readonly repository: RepositoryReference; readonly destination: string }
  | { readonly op: 'fetch'; readonly workdir: string }
  | {
      readonly op: 'createBranch'
      readonly workdir: string
      readonly name: string
      readonly baseRef?: string
    }
  | { readonly op: 'status'; readonly workdir: string; readonly result: RepoStatus }
  | {
      readonly op: 'diff'
      readonly workdir: string
      readonly baseRef?: string
      readonly result: DiffSummary
    }
  | {
      readonly op: 'commit'
      readonly workdir: string
      readonly options: CommitOptions
      readonly result: CommitInfo
    }
  | { readonly op: 'push'; readonly workdir: string; readonly branch: string }
  | {
      readonly op: 'createPullRequest'
      readonly request: PullRequestRequest
      readonly result: PullRequestInfo
    }

interface WorkdirState {
  branch: string
  commits: CommitInfo[]
  dirty: boolean
  changedFiles: string[]
  ahead: number
  behind: number
}

export interface FakeSourceControlProviderOptions {
  readonly info?: Partial<ProviderInfo>
}

const EMPTY_DIFF: DiffSummary = { filesChanged: 0, insertions: 0, deletions: 0, patch: '' }

export class FakeSourceControlProvider implements SourceControlProvider {
  readonly info: ProviderInfo
  readonly calls: ScmProviderCall[] = []

  private readonly workdirs = new Map<string, WorkdirState>()
  private readonly diffOverrides = new Map<string, DiffSummary>()
  private commitSeq = 0
  private prSeq = 0

  constructor(options: FakeSourceControlProviderOptions = {}) {
    this.info = {
      id: 'fake-scm',
      displayName: 'Fake Source Control Provider',
      kind: 'scm',
      consumption: 'local',
      authentication: ['none'],
      ...options.info,
    }
  }

  /** Test helper: mark a workdir as having uncommitted changes. */
  setDirty(workdir: string, dirty: boolean, changedFiles: readonly string[] = []): void {
    const state = this.state(workdir)
    state.dirty = dirty
    state.changedFiles = [...changedFiles]
  }

  /** Test helper: configure the ahead/behind counters status() reports. */
  setAheadBehind(workdir: string, ahead: number, behind: number): void {
    const state = this.state(workdir)
    state.ahead = ahead
    state.behind = behind
  }

  /** Test helper: configure what diff() returns for a workdir. */
  setDiffResult(workdir: string, diff: DiffSummary): void {
    this.diffOverrides.set(workdir, diff)
  }

  /** Test helper: inspect the recorded commit history for a workdir. */
  commitsFor(workdir: string): readonly CommitInfo[] {
    return this.state(workdir).commits
  }

  private state(workdir: string): WorkdirState {
    let state = this.workdirs.get(workdir)
    if (!state) {
      state = { branch: 'main', commits: [], dirty: false, changedFiles: [], ahead: 0, behind: 0 }
      this.workdirs.set(workdir, state)
    }
    return state
  }

  async detect(): Promise<ProviderAvailability> {
    return { installed: true, authenticated: true, available: true }
  }

  async clone(repository: RepositoryReference, destination: string): Promise<void> {
    const state = this.state(destination)
    state.branch = repository.defaultBranch ?? 'main'
    this.calls.push({ op: 'clone', repository, destination })
  }

  async fetch(workdir: string): Promise<void> {
    this.calls.push({ op: 'fetch', workdir })
  }

  async createBranch(workdir: string, name: string, baseRef?: string): Promise<void> {
    this.state(workdir).branch = name
    this.calls.push({
      op: 'createBranch',
      workdir,
      name,
      ...(baseRef !== undefined ? { baseRef } : {}),
    })
  }

  async status(workdir: string): Promise<RepoStatus> {
    const state = this.state(workdir)
    const result: RepoStatus = {
      branch: state.branch,
      clean: !state.dirty,
      ahead: state.ahead,
      behind: state.behind,
      changedFiles: state.changedFiles,
    }
    this.calls.push({ op: 'status', workdir, result })
    return result
  }

  async diff(workdir: string, baseRef?: string): Promise<DiffSummary> {
    const result = this.diffOverrides.get(workdir) ?? EMPTY_DIFF
    this.calls.push({ op: 'diff', workdir, ...(baseRef !== undefined ? { baseRef } : {}), result })
    return result
  }

  async commit(workdir: string, options: CommitOptions): Promise<CommitInfo> {
    const state = this.state(workdir)
    const result: CommitInfo = { sha: `fake-sha-${++this.commitSeq}`, message: options.message }
    state.commits.push(result)
    state.dirty = false
    state.changedFiles = []
    this.calls.push({ op: 'commit', workdir, options, result })
    return result
  }

  async push(workdir: string, branch: string): Promise<void> {
    this.state(workdir).ahead = 0
    this.calls.push({ op: 'push', workdir, branch })
  }

  async createPullRequest(request: PullRequestRequest): Promise<PullRequestInfo> {
    this.prSeq += 1
    const result: PullRequestInfo = {
      id: `fake-pr-${this.prSeq}`,
      number: this.prSeq,
      url: `https://fake-scm.local/${request.repository.locator}/pulls/${this.prSeq}`,
    }
    this.calls.push({ op: 'createPullRequest', request, result })
    return result
  }
}
