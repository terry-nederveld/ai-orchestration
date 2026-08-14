/**
 * Behavioral contract every WorkspaceProvider implementation must satisfy:
 * create() yields a real, usable directory, and cleanup() honors retention.
 */

import { stat } from 'node:fs/promises'
import { asId, type WorkspaceProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function describeWorkspaceProviderContract(
  name: string,
  factory: () => WorkspaceProvider | Promise<WorkspaceProvider>,
): void {
  describe(`WorkspaceProvider contract: ${name}`, () => {
    it('exposes static provider info identifying it as a workspace provider', async () => {
      const provider = await factory()
      expect(provider.info.id).toBeTruthy()
      expect(provider.info.kind).toBe('workspace')
    })

    it('create() returns a workspace backed by a directory that exists', async () => {
      const provider = await factory()
      const workspace = await provider.create({ runId: asId('run-contract-create') })
      expect(workspace.path).toBeTruthy()
      expect(await pathExists(workspace.path)).toBe(true)
      await provider.cleanup(workspace, 'never', false)
    })

    it("cleanup() with retention 'always' keeps the directory regardless of failure", async () => {
      const provider = await factory()
      const workspace = await provider.create({ runId: asId('run-contract-always') })
      await provider.cleanup(workspace, 'always', true)
      expect(await pathExists(workspace.path)).toBe(true)
      await provider.cleanup(workspace, 'never', false) // actual teardown so the test doesn't leak a temp dir
    })

    it("cleanup() with retention 'never' removes the directory", async () => {
      const provider = await factory()
      const workspace = await provider.create({ runId: asId('run-contract-never') })
      await provider.cleanup(workspace, 'never', false)
      expect(await pathExists(workspace.path)).toBe(false)
    })

    it("cleanup() with retention 'on-failure' keeps only when the run failed", async () => {
      const provider = await factory()

      const kept = await provider.create({ runId: asId('run-contract-on-failure-kept') })
      await provider.cleanup(kept, 'on-failure', true)
      expect(await pathExists(kept.path)).toBe(true)
      await provider.cleanup(kept, 'never', false)

      const removed = await provider.create({ runId: asId('run-contract-on-failure-removed') })
      await provider.cleanup(removed, 'on-failure', false)
      expect(await pathExists(removed.path)).toBe(false)
    })
  })
}
