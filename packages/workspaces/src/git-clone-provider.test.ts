import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asId, OrchestratorError } from '@overture/core'
import { GitSourceControlProvider } from '@overture/scm-git'
import { afterEach, describe, expect, it } from 'vitest'
import { GitCloneWorkspaceProvider } from './git-clone-provider.js'
import { initRepo, makeTempDir, removeDir } from './test-helpers.js'

describe('GitCloneWorkspaceProvider', () => {
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
    const origin = await tempDir('overture-clone-origin-')
    await initRepo(origin)
    await writeFile(join(origin, 'README.md'), 'hello\n')
    const scm = new GitSourceControlProvider()
    await scm.commit(origin, { message: 'chore: init' })
    return origin
  }

  it('clones a fresh, isolated workspace per run on a new branch', async () => {
    const origin = await makeOriginRepo()
    const scm = new GitSourceControlProvider()
    const workspacesRoot = await tempDir('overture-clone-ws-')
    const provider = new GitCloneWorkspaceProvider({ workspacesRoot, scm })

    const ws1 = await provider.create({ runId: asId('run-1'), repository: { locator: origin } })
    const ws2 = await provider.create({ runId: asId('run-2'), repository: { locator: origin } })

    expect(ws1.path).not.toBe(ws2.path)
    expect(ws1.branch).toBe('overture/run-1')
    expect(ws2.branch).toBe('overture/run-2')

    await writeFile(join(ws1.path, 'only-in-1.txt'), 'x\n')
    await expect(stat(join(ws2.path, 'only-in-1.txt'))).rejects.toThrow()

    const content = await readFile(join(ws1.path, 'README.md'), 'utf8')
    expect(content).toBe('hello\n')
  })

  it('cleans up according to retention policy', async () => {
    const origin = await makeOriginRepo()
    const scm = new GitSourceControlProvider()
    const workspacesRoot = await tempDir('overture-clone-ws-cleanup-')
    const provider = new GitCloneWorkspaceProvider({ workspacesRoot, scm })

    const ws = await provider.create({ runId: asId('run-1'), repository: { locator: origin } })
    await provider.cleanup(ws, 'never', false)
    await expect(stat(ws.path)).rejects.toThrow()
  })

  it('keeps a traversal-laden runId confined inside workspacesRoot', async () => {
    const origin = await makeOriginRepo()
    const scm = new GitSourceControlProvider()
    const workspacesRoot = await tempDir('overture-clone-ws-traversal-')
    const provider = new GitCloneWorkspaceProvider({ workspacesRoot, scm })

    const ws = await provider.create({
      runId: asId('../../etc/passwd'),
      repository: { locator: origin },
    })
    expect(ws.path.startsWith(workspacesRoot)).toBe(true)
  })

  it('requires a repository reference', async () => {
    const scm = new GitSourceControlProvider()
    const workspacesRoot = await tempDir('overture-clone-ws-norepo-')
    const provider = new GitCloneWorkspaceProvider({ workspacesRoot, scm })
    await expect(provider.create({ runId: asId('run-1') })).rejects.toBeInstanceOf(
      OrchestratorError,
    )
  })
})
