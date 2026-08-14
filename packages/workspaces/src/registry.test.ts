import { OrchestratorError } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { WorkspaceProviderRegistry } from './registry.js'
import { TempDirectoryWorkspaceProvider } from './temp-directory-provider.js'

describe('WorkspaceProviderRegistry', () => {
  it('resolves a registered provider by strategy', () => {
    const registry = new WorkspaceProviderRegistry()
    const provider = new TempDirectoryWorkspaceProvider()
    registry.register(provider)
    expect(registry.has('temp-directory')).toBe(true)
    expect(registry.resolve('temp-directory')).toBe(provider)
  })

  it('throws for an unregistered strategy', () => {
    const registry = new WorkspaceProviderRegistry()
    expect(() => registry.resolve('git-clone')).toThrow(OrchestratorError)
  })
})
