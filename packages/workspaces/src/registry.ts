/**
 * WorkspaceProviderRegistry: maps a WorkspaceStrategy to its provider. The
 * orchestrator resolves the provider for a run through this registry rather
 * than depending on concrete provider classes.
 */

import { OrchestratorError, type WorkspaceProvider, type WorkspaceStrategy } from '@overture/core'

export class WorkspaceProviderRegistry {
  private readonly providers = new Map<WorkspaceStrategy, WorkspaceProvider>()

  register(provider: WorkspaceProvider): void {
    this.providers.set(provider.strategy, provider)
  }

  has(strategy: WorkspaceStrategy): boolean {
    return this.providers.has(strategy)
  }

  resolve(strategy: WorkspaceStrategy): WorkspaceProvider {
    const provider = this.providers.get(strategy)
    if (!provider) {
      throw new OrchestratorError(
        `No workspace provider registered for strategy "${strategy}"`,
        'invalid-input',
      )
    }
    return provider
  }
}
