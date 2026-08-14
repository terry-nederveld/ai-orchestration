/**
 * Source-control contract. Git-first but platform-neutral: issue tracking and
 * source hosting are deliberately independent provider dimensions.
 */

import type { ProviderAvailability, ProviderInfo } from './capabilities.js'
import type { RepositoryReference } from './work.js'

export interface CommitOptions {
  readonly message: string
  readonly authorName?: string
  readonly authorEmail?: string
  /** Paths to stage; stages all changes when omitted. */
  readonly paths?: readonly string[]
}

export interface CommitInfo {
  readonly sha: string
  readonly message: string
}

export interface DiffSummary {
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly patch: string
}

export interface RepoStatus {
  readonly branch: string
  readonly clean: boolean
  readonly ahead: number
  readonly behind: number
  readonly changedFiles: readonly string[]
}

export interface PullRequestRequest {
  readonly repository: RepositoryReference
  readonly title: string
  readonly body: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly draft?: boolean
}

export interface PullRequestInfo {
  readonly id: string
  readonly number?: number
  readonly url: string
}

export interface SourceControlProvider {
  readonly info: ProviderInfo
  detect(): Promise<ProviderAvailability>
  clone(repository: RepositoryReference, destination: string): Promise<void>
  fetch(workdir: string): Promise<void>
  createBranch(workdir: string, name: string, baseRef?: string): Promise<void>
  status(workdir: string): Promise<RepoStatus>
  diff(workdir: string, baseRef?: string): Promise<DiffSummary>
  commit(workdir: string, options: CommitOptions): Promise<CommitInfo>
  push(workdir: string, branch: string): Promise<void>
  /** Optional: hosting platforms only (PRs are not a Git-core concept). */
  createPullRequest?(request: PullRequestRequest): Promise<PullRequestInfo>
}
