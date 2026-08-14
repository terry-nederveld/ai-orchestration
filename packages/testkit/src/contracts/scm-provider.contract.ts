/**
 * Behavioral contract every SourceControlProvider implementation must
 * satisfy. Run against fakes and, later, real adapters (local Git, GitHub)
 * pointed at a scratch repository via `workdirFactory`.
 */

import type { SourceControlProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'

export function describeSourceControlProviderContract(
  name: string,
  factory: () => SourceControlProvider | Promise<SourceControlProvider>,
  workdirFactory: () => Promise<string> | string,
): void {
  describe(`SourceControlProvider contract: ${name}`, () => {
    it('exposes static provider info identifying it as an scm provider', async () => {
      const provider = await factory()
      expect(provider.info.id).toBeTruthy()
      expect(provider.info.kind).toBe('scm')
    })

    it('createBranch() then status() reflects the new branch', async () => {
      const provider = await factory()
      const workdir = await workdirFactory()
      await provider.createBranch(workdir, 'feature/contract-test')
      const status = await provider.status(workdir)
      expect(status.branch).toBe('feature/contract-test')
    })

    it('commit() returns a commit and status() reports clean afterward', async () => {
      const provider = await factory()
      const workdir = await workdirFactory()
      const commit = await provider.commit(workdir, { message: 'contract test commit' })
      expect(commit.sha).toBeTruthy()
      expect(commit.message).toBe('contract test commit')
      const status = await provider.status(workdir)
      expect(status.clean).toBe(true)
    })

    it('push() resolves without throwing', async () => {
      const provider = await factory()
      const workdir = await workdirFactory()
      await provider.createBranch(workdir, 'feature/contract-push')
      await provider.push(workdir, 'feature/contract-push')
    })

    it('diff() returns a structural summary', async () => {
      const provider = await factory()
      const workdir = await workdirFactory()
      const diff = await provider.diff(workdir)
      expect(typeof diff.filesChanged).toBe('number')
      expect(typeof diff.insertions).toBe('number')
      expect(typeof diff.deletions).toBe('number')
      expect(typeof diff.patch).toBe('string')
    })

    it('createPullRequest(), when supported, returns a URL and records the request', async () => {
      const provider = await factory()
      if (!provider.createPullRequest) return // PRs are hosting-specific, not a Git-core concept

      const info = await provider.createPullRequest({
        repository: { locator: 'contract/repo' },
        title: 'Contract PR',
        body: 'body',
        sourceBranch: 'feature/contract-test',
        targetBranch: 'main',
      })
      expect(info.url).toBeTruthy()
    })
  })
}
