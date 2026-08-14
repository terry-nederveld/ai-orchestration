import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitSourceControlProvider } from './git-provider.js'
import { initRepo, makeTempDir, removeDir } from './test-helpers.js'
import { GitWorktreeManager } from './worktree-manager.js'

describe('GitWorktreeManager', () => {
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

  async function makeRepo(): Promise<string> {
    const repo = await tempDir('overture-wt-repo-')
    await initRepo(repo)
    await writeFile(join(repo, 'README.md'), 'hello\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(repo, { message: 'chore: init' })
    return repo
  }

  it('adds, lists, and removes worktrees, isolating each working tree', async () => {
    const repo = await makeRepo()
    const worktrees = new GitWorktreeManager()
    const scm = new GitSourceControlProvider()

    const wtRoot = await tempDir('overture-wt-')
    const wt1 = join(wtRoot, 'run-1')
    const wt2 = join(wtRoot, 'run-2')

    await worktrees.addWorktree(repo, wt1, 'run-1-branch', 'main')
    await worktrees.addWorktree(repo, wt2, 'run-2-branch', 'main')

    // git canonicalizes worktree paths (e.g. resolving /var symlinks on
    // macOS), so compare against realpath rather than the raw mkdtemp path.
    const realWt1 = await realpath(wt1)
    const realWt2 = await realpath(wt2)

    const list = await worktrees.listWorktrees(repo)
    // main worktree (repo itself) + the two added worktrees
    expect(list.length).toBe(3)
    const paths = list.map((entry) => entry.path)
    expect(paths).toContain(realWt1)
    expect(paths).toContain(realWt2)

    const wt1Entry = list.find((entry) => entry.path === realWt1)
    expect(wt1Entry?.branch).toBe('run-1-branch')

    // Commit in worktree 1 must not affect worktree 2's working tree.
    await writeFile(join(wt1, 'only-in-wt1.txt'), 'content\n')
    await scm.commit(wt1, { message: 'feat: only in wt1' })

    const status2 = await scm.status(wt2)
    expect(status2.changedFiles).toEqual([])

    await worktrees.removeWorktree(repo, wt1)
    const listAfterRemove = await worktrees.listWorktrees(repo)
    expect(listAfterRemove.map((entry) => entry.path)).not.toContain(realWt1)
    expect(listAfterRemove.map((entry) => entry.path)).toContain(realWt2)
  })

  it('force-removes a worktree with uncommitted changes', async () => {
    const repo = await makeRepo()
    const worktrees = new GitWorktreeManager()
    const wtRoot = await tempDir('overture-wt-force-')
    const wt = join(wtRoot, 'run-dirty')

    await worktrees.addWorktree(repo, wt, 'dirty-branch', 'main')
    await writeFile(join(wt, 'dirty.txt'), 'dirty\n')
    const realWt = await realpath(wt)

    await worktrees.removeWorktree(repo, wt, true)
    const list = await worktrees.listWorktrees(repo)
    expect(list.map((entry) => entry.path)).not.toContain(realWt)
  })
})
