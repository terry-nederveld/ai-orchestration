/**
 * InMemorySecretProvider: a non-persistent SecretProvider fake. Values never
 * leave process memory, matching the contract's promise that raw values are
 * never logged or listed.
 */

import type { SecretMetadata, SecretProvider } from '@overture/core'

export class InMemorySecretProvider implements SecretProvider {
  readonly id: string

  private readonly values = new Map<string, string>()
  private readonly meta = new Map<string, SecretMetadata>()

  constructor(id = 'in-memory-secrets') {
    this.id = id
  }

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name)
  }

  async set(name: string, value: string): Promise<void> {
    const now = new Date()
    const existing = this.meta.get(name)
    this.values.set(name, value)
    this.meta.set(name, { name, createdAt: existing?.createdAt ?? now, updatedAt: now })
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name)
    this.meta.delete(name)
  }

  async list(prefix?: string): Promise<readonly SecretMetadata[]> {
    return [...this.meta.values()].filter((m) => prefix === undefined || m.name.startsWith(prefix))
  }
}
