import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asId, OrchestratorError } from '@overture/core'
import { GitSourceControlProvider, GitWorktreeManager } from '@overture/scm-git'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
import { initRepo, makeTempDir, removeDir } from './test-helpers.js'

describe('GitWorktreeWorkspaceProvider', () => {
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

  async function makeOriginRepo(): Promise<string> {
    const origin = await tempDir('overture-wtws-origin-')
    await initRepo(origin)
    await writeFile(join(origin, 'README.md'), 'hello\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(origin, { message: 'chore: init' })
    return origin
  }

  function makeProvider(reposRoot: string, workspacesRoot: string) {
    return new GitWorktreeWorkspaceProvider({
      reposRoot,
      workspacesRoot,
      scm: new GitSourceControlProvider(),
      worktrees: new GitWorktreeManager(),
    })
  }

  it('clones the base repo once and creates isolated worktrees per run', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-')
    const workspacesRoot = await tempDir('overture-wtws-ws-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const ws1 = await provider.create({
      runId: asId('run-1'),
      repository: { locator: origin },
      baseRef: 'main',
    })
    const ws2 = await provider.create({
      runId: asId('run-2'),
      repository: { locator: origin },
      baseRef: 'main',
    })

    expect(ws1.path).not.toBe(ws2.path)
    expect(ws1.branch).toBe('overture/run-1')
    expect(ws2.branch).toBe('overture/run-2')

    // Commits in one worktree must not appear in the other's working tree.
    await writeFile(join(ws1.path, 'only-in-1.txt'), 'x\n')
    await expect(stat(join(ws2.path, 'only-in-1.txt'))).rejects.toThrow()
  })

  it('reuses the same base repo clone across runs (no second clone dir)', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-reuse-')
    const workspacesRoot = await tempDir('overture-wtws-ws-reuse-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    await provider.create({
      runId: asId('run-1'),
      repository: { locator: origin },
      baseRef: 'main',
    })
    await provider.create({
      runId: asId('run-2'),
      repository: { locator: origin },
      baseRef: 'main',
    })

    const entries = await import('node:fs/promises').then((fs) => fs.readdir(reposRoot))
    expect(entries).toHaveLength(1)
  })

  it('creates concurrent workspaces for different runs without colliding', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-concurrent-')
    const workspacesRoot = await tempDir('overture-wtws-ws-concurrent-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const [ws1, ws2, ws3] = await Promise.all([
      provider.create({ runId: asId('run-a'), repository: { locator: origin }, baseRef: 'main' }),
      provider.create({ runId: asId('run-b'), repository: { locator: origin }, baseRef: 'main' }),
      provider.create({ runId: asId('run-c'), repository: { locator: origin }, baseRef: 'main' }),
    ])

    const paths = new Set([ws1.path, ws2.path, ws3.path])
    expect(paths.size).toBe(3)
    for (const ws of [ws1, ws2, ws3]) {
      const info = await stat(ws.path)
      expect(info.isDirectory()).toBe(true)
    }
  })

  it('falls back to local HEAD when the origin has no remote HEAD symref and no explicit baseRef', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-fallback-')
    const workspacesRoot = await tempDir('overture-wtws-ws-fallback-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const ws = await provider.create({ runId: asId('run-1'), repository: { locator: origin } })
    const content = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(ws.path, 'README.md'), 'utf8'),
    )
    expect(content).toBe('hello\n')
  })

  it('removes the worktree on cleanup per retention policy', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-cleanup-')
    const workspacesRoot = await tempDir('overture-wtws-ws-cleanup-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const ws = await provider.create({
      runId: asId('run-1'),
      repository: { locator: origin },
      baseRef: 'main',
    })
    await provider.cleanup(ws, 'never', false)
    await expect(stat(ws.path)).rejects.toThrow()
  })

  it('keeps the worktree on cleanup when retention says to', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-keep-')
    const workspacesRoot = await tempDir('overture-wtws-ws-keep-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const ws = await provider.create({
      runId: asId('run-1'),
      repository: { locator: origin },
      baseRef: 'main',
    })
    await provider.cleanup(ws, 'always', false)
    await expect(stat(ws.path)).resolves.toBeDefined()
  })

  it('keeps a traversal-laden runId confined inside workspacesRoot', async () => {
    const origin = await makeOriginRepo()
    const reposRoot = await tempDir('overture-wtws-repos-traversal-')
    const workspacesRoot = await tempDir('overture-wtws-ws-traversal-')
    const provider = makeProvider(reposRoot, workspacesRoot)

    const ws = await provider.create({
      runId: asId('../../etc/passwd'),
      repository: { locator: origin },
      baseRef: 'main',
    })
    expect(ws.path.startsWith(workspacesRoot)).toBe(true)
  })

  it('requires a repository reference', async () => {
    const reposRoot = await tempDir('overture-wtws-repos-norepo-')
    const workspacesRoot = await tempDir('overture-wtws-ws-norepo-')
    const provider = makeProvider(reposRoot, workspacesRoot)
    await expect(provider.create({ runId: asId('run-1') })).rejects.toBeInstanceOf(
      OrchestratorError,
    )
  })
})
