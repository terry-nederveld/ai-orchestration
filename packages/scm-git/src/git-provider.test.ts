import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OrchestratorError } from '@overture/core'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSafe } from './exec.js'
import { GitSourceControlProvider } from './git-provider.js'
import { initRepo, makeTempDir, removeDir } from './test-helpers.js'

describe('GitSourceControlProvider', () => {
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

  it('detects an installed git binary', async () => {
    const scm = new GitSourceControlProvider()
    const availability = await scm.detect()
    expect(availability.installed).toBe(true)
    expect(availability.available).toBe(true)
  })

  it('reports unavailable for a missing binary', async () => {
    const scm = new GitSourceControlProvider({ gitBinary: 'definitely-not-a-real-git-binary' })
    const availability = await scm.detect()
    expect(availability.available).toBe(false)
  })

  it('clones from a local path, branches, commits, and diffs round-trip', async () => {
    const origin = await tempDir('overture-origin-')
    await initRepo(origin)
    await writeFile(join(origin, 'README.md'), 'hello\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(origin, { message: 'chore: initial commit' })

    const clonePath = join(await tempDir('overture-clones-'), 'work')
    await scm.clone({ locator: origin }, clonePath)

    await scm.createBranch(clonePath, 'feature/thing', 'main')
    const statusAfterBranch = await scm.status(clonePath)
    expect(statusAfterBranch.branch).toBe('feature/thing')
    expect(statusAfterBranch.clean).toBe(true)

    await writeFile(join(clonePath, 'file.txt'), 'line one\nline two\n')
    const statusDirty = await scm.status(clonePath)
    expect(statusDirty.clean).toBe(false)
    expect(statusDirty.changedFiles).toContain('file.txt')

    const commitInfo = await scm.commit(clonePath, { message: 'feat: add file' })
    expect(commitInfo.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commitInfo.message).toBe('feat: add file')

    const statusClean = await scm.status(clonePath)
    expect(statusClean.clean).toBe(true)

    const diff = await scm.diff(clonePath, 'main')
    expect(diff.filesChanged).toBe(1)
    expect(diff.insertions).toBe(2)
    expect(diff.deletions).toBe(0)
    expect(diff.patch).toContain('file.txt')
  })

  it('applies provided author identity to commits', async () => {
    const repo = await tempDir('overture-author-')
    await initRepo(repo)
    await writeFile(join(repo, 'a.txt'), 'a\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(repo, {
      message: 'feat: add a',
      authorName: 'Custom Author',
      authorEmail: 'custom@example.com',
    })

    const { stdout } = await execFileSafe('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repo })
    expect(stdout.trim()).toBe('Custom Author <custom@example.com>')
  })

  it('stages only specified paths when paths are given', async () => {
    const repo = await tempDir('overture-paths-')
    await initRepo(repo)
    await writeFile(join(repo, 'keep.txt'), 'keep\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(repo, { message: 'chore: init' })

    await writeFile(join(repo, 'included.txt'), 'included\n')
    await writeFile(join(repo, 'excluded.txt'), 'excluded\n')
    await scm.commit(repo, { message: 'feat: partial add', paths: ['included.txt'] })

    const status = await scm.status(repo)
    expect(status.changedFiles).toEqual(['excluded.txt'])
  })

  it('refuses to commit messages carrying attribution trailers', async () => {
    const repo = await tempDir('overture-policy-')
    await initRepo(repo)
    await writeFile(join(repo, 'a.txt'), 'a\n')
    const scm = new GitSourceControlProvider()

    let error: unknown
    try {
      await scm.commit(repo, {
        message: 'feat: add a\n\nCo-authored-by: Someone <someone@example.com>',
      })
    } catch (thrown) {
      error = thrown
    }

    expect(error).toBeInstanceOf(OrchestratorError)
    expect((error as OrchestratorError).category).toBe('policy')

    // Nothing should have been committed.
    const { stdout } = await execFileSafe('git', ['log', '--oneline'], { cwd: repo }).catch(() => ({
      stdout: '',
      stderr: '',
    }))
    expect(stdout.trim()).toBe('')
  })

  it('handles filenames with spaces and shell-meaningful characters safely', async () => {
    const repo = await tempDir('overture-injection-')
    await initRepo(repo)
    const trickyName = 'weird; name $(echo pwned) & file.txt'
    await writeFile(join(repo, trickyName), 'content\n')

    const scm = new GitSourceControlProvider()
    const status = await scm.status(repo)
    expect(status.changedFiles).toContain(trickyName)

    const commitInfo = await scm.commit(repo, { message: 'feat: add tricky file' })
    expect(commitInfo.sha).toMatch(/^[0-9a-f]{40}$/)

    const content = await readFile(join(repo, trickyName), 'utf8')
    expect(content).toBe('content\n')

    // Exactly the tricky filename is tracked - no stray file (e.g. a literal
    // "pwned" file) was created by shell interpretation of its contents.
    const { stdout } = await execFileSafe('git', ['ls-files'], { cwd: repo })
    const trackedFiles = stdout.split('\n').filter((line) => line.length > 0)
    expect(trackedFiles).toEqual([trickyName])
  })

  it('reports ahead/behind counts relative to upstream', async () => {
    const origin = await tempDir('overture-ahead-origin-')
    await initRepo(origin)
    await writeFile(join(origin, 'a.txt'), 'a\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(origin, { message: 'chore: init' })
    await execFileSafe('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: origin })

    const clonePath = join(await tempDir('overture-ahead-clone-'), 'work')
    await scm.clone({ locator: origin }, clonePath)
    await writeFile(join(clonePath, 'b.txt'), 'b\n')
    await scm.commit(clonePath, { message: 'feat: add b' })

    const status = await scm.status(clonePath)
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(0)
  })

  it('commits with a fallback identity when none is configured (CI runners)', async () => {
    // Isolate from any global/system git config so the machine's own
    // identity cannot mask the missing-ident case CI runners hit.
    const isolated = new GitSourceControlProvider({
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    const origin = await tempDir('origin')
    await initRepo(origin)
    const clonePath = join(await tempDir('clone'), 'repo')
    await isolated.clone({ locator: origin }, clonePath)

    await writeFile(join(clonePath, 'new.txt'), 'content\n')
    const info = await isolated.commit(clonePath, { message: 'feat: add file without identity' })
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/)

    const { stdout } = await execFileSafe('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: clonePath,
    })
    expect(stdout.trim()).toBe('Overture <overture@localhost>')
  })

  it('explicit author options override the fallback identity', async () => {
    const isolated = new GitSourceControlProvider({
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    const origin = await tempDir('origin')
    await initRepo(origin)
    const clonePath = join(await tempDir('clone'), 'repo')
    await isolated.clone({ locator: origin }, clonePath)

    await writeFile(join(clonePath, 'new.txt'), 'content\n')
    await isolated.commit(clonePath, {
      message: 'feat: add file with explicit author',
      authorName: 'Custom Author',
      authorEmail: 'custom@example.com',
    })
    const { stdout } = await execFileSafe('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: clonePath,
    })
    expect(stdout.trim()).toBe('Custom Author <custom@example.com>')
  })
})
