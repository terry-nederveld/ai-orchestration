import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asId } from '@overture/core'
import { afterAll, describe, expect, it } from 'vitest'
import { describeWorkspaceProviderContract } from './contracts/workspace-provider.contract.js'
import { FakeWorkspaceProvider } from './workspace-provider.js'

const baseDirs: FakeWorkspaceProvider[] = []
function newProvider(): FakeWorkspaceProvider {
  const provider = new FakeWorkspaceProvider()
  baseDirs.push(provider)
  return provider
}

describeWorkspaceProviderContract('FakeWorkspaceProvider', newProvider)

describe('FakeWorkspaceProvider', () => {
  it('creates a directory tools can actually write files into', async () => {
    const provider = newProvider()
    const workspace = await provider.create({ runId: asId('run-write-test') })
    await writeFile(join(workspace.path, 'note.txt'), 'hello from a tool')
    const contents = await readFile(join(workspace.path, 'note.txt'), 'utf8')
    expect(contents).toBe('hello from a tool')
    await provider.cleanup(workspace, 'never', false)
  })

  it('records a cleanup entry describing the action taken', async () => {
    const provider = newProvider()
    const workspace = await provider.create({ runId: asId('run-cleanup-log') })
    await provider.cleanup(workspace, 'never', false)
    expect(provider.cleanups).toHaveLength(1)
    expect(provider.cleanups[0]).toMatchObject({
      retention: 'never',
      failed: false,
      action: 'deleted',
    })
  })

  it('cleanup() is idempotent when the directory is already gone', async () => {
    const provider = newProvider()
    const workspace = await provider.create({ runId: asId('run-idempotent') })
    await provider.cleanup(workspace, 'never', false)
    await expect(provider.cleanup(workspace, 'never', false)).resolves.toBeUndefined()
  })

  it('carries repository and branch onto the created workspace when provided', async () => {
    const provider = newProvider()
    const workspace = await provider.create({
      runId: asId('run-with-repo'),
      repository: { locator: 'org/repo' },
      branch: 'feature/x',
    })
    expect(workspace.repository).toEqual({ locator: 'org/repo' })
    expect(workspace.branch).toBe('feature/x')
    await provider.cleanup(workspace, 'never', false)
  })

  it('omits branch and repository when the request does not supply them', async () => {
    const provider = newProvider()
    const workspace = await provider.create({ runId: asId('run-bare') })
    expect(workspace.repository).toBeUndefined()
    expect(workspace.branch).toBeUndefined()
    await provider.cleanup(workspace, 'never', false)
  })
})

afterAll(async () => {
  // Best-effort sweep in case any 'always'/'on-failure' test above left a temp dir behind.
  for (const provider of baseDirs) {
    for (const record of provider.cleanups) {
      if (record.action === 'kept') {
        await provider.cleanup(record.workspace, 'never', false).catch(() => {})
      }
    }
  }
})
