import { stat } from 'node:fs/promises'
import { asId, OrchestratorError } from '@overture/core'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDirectoryWorkspaceProvider } from './local-directory-provider.js'
import { makeTempDir, removeDir } from './test-helpers.js'

describe('LocalDirectoryWorkspaceProvider', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await removeDir(dir)
  })

  it('uses an existing directory as-is via repository.locator', async () => {
    dir = await makeTempDir('overture-local-')
    const provider = new LocalDirectoryWorkspaceProvider()
    const workspace = await provider.create({ runId: asId('run-1'), repository: { locator: dir } })
    expect(workspace.path).toBe(dir)
    expect(workspace.strategy).toBe('local-directory')
  })

  it('falls back to a configured defaultPath when no repository is given', async () => {
    dir = await makeTempDir('overture-local-default-')
    const provider = new LocalDirectoryWorkspaceProvider({ defaultPath: dir })
    const workspace = await provider.create({ runId: asId('run-1') })
    expect(workspace.path).toBe(dir)
  })

  it('rejects a nonexistent directory', async () => {
    const provider = new LocalDirectoryWorkspaceProvider()
    await expect(
      provider.create({
        runId: asId('run-1'),
        repository: { locator: '/does/not/exist/anywhere' },
      }),
    ).rejects.toBeInstanceOf(OrchestratorError)
  })

  it('never deletes on cleanup, regardless of retention policy', async () => {
    dir = await makeTempDir('overture-local-cleanup-')
    const provider = new LocalDirectoryWorkspaceProvider()
    const workspace = await provider.create({ runId: asId('run-1'), repository: { locator: dir } })
    await provider.cleanup(workspace, 'never', true)
    await expect(stat(dir)).resolves.toBeDefined()
  })
})
