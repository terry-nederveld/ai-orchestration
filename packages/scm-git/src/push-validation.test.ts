/**
 * Security remediation ATTRIB-BYPASS: push() is the delivery choke point.
 * An agent can commit directly via a shell tool (bypassing commit()'s
 * attribution check entirely), so push() must independently scan every
 * commit it is about to publish.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OrchestratorError } from '@overture/core'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSafe } from './exec.js'
import { GitSourceControlProvider } from './git-provider.js'
import { GitHubSourceControlProvider } from './github-provider.js'
import { initRepo, makeTempDir, removeDir } from './test-helpers.js'

describe('push() attribution validation', { timeout: 30_000 }, () => {
  let dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => removeDir(dir)))
    dirs = []
  })

  async function tempDir(prefix: string): Promise<string> {
    const dir = await makeTempDir(prefix)
    dirs.push(dir)
    return dir
  }

  /** Bare origin seeded with a clean "chore: seed" commit on main, plus a clone with `origin` configured. */
  async function makeOriginAndClone(): Promise<{ origin: string; clone: string }> {
    const origin = await tempDir('overture-push-origin-')
    await execFileSafe('git', ['init', '--bare', '-b', 'main', origin])

    const seed = await tempDir('overture-push-seed-')
    await initRepo(seed)
    await writeFile(join(seed, 'README.md'), 'hello\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(seed, { message: 'chore: seed' })
    await execFileSafe('git', ['remote', 'add', 'origin', origin], { cwd: seed })
    await scm.push(seed, 'main')

    const clone = join(await tempDir('overture-push-clones-'), 'work')
    await scm.clone({ locator: origin }, clone)
    await execFileSafe('git', ['config', 'user.email', 'test@example.com'], { cwd: clone })
    await execFileSafe('git', ['config', 'user.name', 'Test User'], { cwd: clone })
    await execFileSafe('git', ['config', 'commit.gpgsign', 'false'], { cwd: clone })

    return { origin, clone }
  }

  async function rawCommit(workdir: string, message: string): Promise<void> {
    // Simulates an agent committing directly via a shell tool, bypassing
    // GitSourceControlProvider.commit() and its attribution check entirely.
    await execFileSafe('git', ['commit', '--allow-empty', '-m', message], { cwd: workdir })
  }

  async function remoteBranchSha(origin: string, branch: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileSafe('git', ['rev-parse', `refs/heads/${branch}`], {
        cwd: origin,
      })
      return stdout.trim()
    } catch {
      return undefined
    }
  }

  it('refuses to push a brand-new branch containing a raw shell commit with an attribution trailer', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: add widget\n\nCo-authored-by: Bot <bot@example.com>')

    let error: unknown
    try {
      await scm.push(clone, 'topic')
    } catch (thrown) {
      error = thrown
    }

    expect(error).toBeInstanceOf(OrchestratorError)
    expect((error as OrchestratorError).category).toBe('policy')
    expect((error as OrchestratorError).message).toContain('feat: add widget')

    // Nothing reached the origin: the branch was never created there.
    expect(await remoteBranchSha(origin, 'topic')).toBeUndefined()
  })

  it('pushes a brand-new branch with only clean commits', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: add widget')

    await scm.push(clone, 'topic')

    const localSha = (
      await execFileSafe('git', ['rev-parse', 'topic'], { cwd: clone })
    ).stdout.trim()
    expect(await remoteBranchSha(origin, 'topic')).toBe(localSha)
  })

  it('refuses a push to a branch that already has an upstream when a new raw commit carries a trailer', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: first clean commit')
    await scm.push(clone, 'topic')
    const shaAfterFirstPush = await remoteBranchSha(origin, 'topic')
    expect(shaAfterFirstPush).toBeDefined()

    await rawCommit(clone, 'feat: second commit\n\nGenerated-by: SomeTool')

    await expect(scm.push(clone, 'topic')).rejects.toMatchObject({ category: 'policy' })

    // The origin ref must not have advanced past the first, clean push.
    expect(await remoteBranchSha(origin, 'topic')).toBe(shaAfterFirstPush)
  })

  it('pushes further clean commits on a branch that already has an upstream', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: first clean commit')
    await scm.push(clone, 'topic')

    await rawCommit(clone, 'feat: second clean commit')
    await scm.push(clone, 'topic')

    const localSha = (
      await execFileSafe('git', ['rev-parse', 'topic'], { cwd: clone })
    ).stdout.trim()
    expect(await remoteBranchSha(origin, 'topic')).toBe(localSha)
  })

  it('detects a trailer inside a multiline commit body containing blank lines', async () => {
    const { clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(
      clone,
      [
        'feat: multi-paragraph change',
        '',
        'This change does several things across a few paragraphs.',
        '',
        'It also touches the docs, for good measure.',
        '',
        'Co-authored-by: Bot <bot@example.com>',
      ].join('\n'),
    )

    await expect(scm.push(clone, 'topic')).rejects.toMatchObject({ category: 'policy' })
  })

  it('pushes a multiline commit body with blank lines and no trailer', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider()

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(
      clone,
      ['feat: multi-paragraph change', '', 'Paragraph one.', '', 'Paragraph two.'].join('\n'),
    )

    await scm.push(clone, 'topic')
    expect(await remoteBranchSha(origin, 'topic')).toBeDefined()
  })

  it('allows an explicit opt-out via skipAttributionCheckOnPush', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitSourceControlProvider({ skipAttributionCheckOnPush: true })

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: add widget\n\nCo-authored-by: Bot <bot@example.com>')

    await scm.push(clone, 'topic')
    expect(await remoteBranchSha(origin, 'topic')).toBeDefined()
  })

  it('GitHubSourceControlProvider inherits the same push-time validation', async () => {
    const { origin, clone } = await makeOriginAndClone()
    const scm = new GitHubSourceControlProvider({
      runner: async () => ({ stdout: '', stderr: '' }),
    })

    await scm.createBranch(clone, 'topic', 'main')
    await rawCommit(clone, 'feat: add widget\n\nAssisted-by: Some Tool')

    await expect(scm.push(clone, 'topic')).rejects.toMatchObject({ category: 'policy' })
    expect(await remoteBranchSha(origin, 'topic')).toBeUndefined()
  })
})
