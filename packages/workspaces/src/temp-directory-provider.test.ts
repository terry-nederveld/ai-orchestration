import { stat } from 'node:fs/promises'
import { asId } from '@overture/core'
import { afterEach, describe, expect, it } from 'vitest'
import { TempDirectoryWorkspaceProvider } from './temp-directory-provider.js'
import { makeTempDir, removeDir } from './test-helpers.js'

describe('TempDirectoryWorkspaceProvider', () => {
  let baseDir: string
  let provider: TempDirectoryWorkspaceProvider

  afterEach(async () => {
    if (baseDir) await removeDir(baseDir)
  })

  it('creates an isolated temp directory with no repository required', async () => {
    baseDir = await makeTempDir('overture-temp-base-')
    provider = new TempDirectoryWorkspaceProvider({ baseDir })

    const workspace = await provider.create({ runId: asId('run-1') })
    expect(workspace.strategy).toBe('temp-directory')
    const info = await stat(workspace.path)
    expect(info.isDirectory()).toBe(true)
  })

  it('deletes on cleanup with never/on-failure(success) retention, keeps on always', async () => {
    baseDir = await makeTempDir('overture-temp-base-')
    provider = new TempDirectoryWorkspaceProvider({ baseDir })

    const ws1 = await provider.create({ runId: asId('run-never') })
    await provider.cleanup(ws1, 'never', false)
    await expect(stat(ws1.path)).rejects.toThrow()

    const ws2 = await provider.create({ runId: asId('run-always') })
    await provider.cleanup(ws2, 'always', false)
    await expect(stat(ws2.path)).resolves.toBeDefined()

    const ws3 = await provider.create({ runId: asId('run-onfail-success') })
    await provider.cleanup(ws3, 'on-failure', false)
    await expect(stat(ws3.path)).rejects.toThrow()

    const ws4 = await provider.create({ runId: asId('run-onfail-failed') })
    await provider.cleanup(ws4, 'on-failure', true)
    await expect(stat(ws4.path)).resolves.toBeDefined()
  })
})
