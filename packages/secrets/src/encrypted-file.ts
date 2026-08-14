/**
 * Encrypted-file secret store: AES-256-GCM with a locally stored key file.
 *
 * This is the fallback when no OS credential store is available. The key file
 * is created with 0600 permissions; protection is comparable to an unencrypted
 * SSH private key — real OS keychains are preferred wherever present.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SecretMetadata, SecretProvider } from '@overture/core'

interface VaultEntry {
  readonly iv: string
  readonly tag: string
  readonly data: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface VaultFile {
  readonly version: 1
  readonly entries: Record<string, VaultEntry>
}

export class EncryptedFileSecretProvider implements SecretProvider {
  readonly id = 'encrypted-file'
  private readonly vaultPath: string
  private readonly keyPath: string
  private key: Buffer | undefined

  constructor(directory: string) {
    this.vaultPath = join(directory, 'secrets.vault.json')
    this.keyPath = join(directory, 'secrets.key')
  }

  async get(name: string): Promise<string | undefined> {
    const vault = await this.readVault()
    const entry = vault.entries[name]
    if (!entry) return undefined
    const key = await this.loadKey()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(entry.data, 'base64')),
      decipher.final(),
    ])
    return plain.toString('utf8')
  }

  async set(name: string, value: string): Promise<void> {
    const vault = await this.readVault()
    const key = await this.loadKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()])
    const now = new Date().toISOString()
    const existing = vault.entries[name]
    vault.entries[name] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.writeVault(vault)
  }

  async delete(name: string): Promise<void> {
    const vault = await this.readVault()
    if (name in vault.entries) {
      delete vault.entries[name]
      await this.writeVault(vault)
    }
  }

  async list(prefix?: string): Promise<readonly SecretMetadata[]> {
    const vault = await this.readVault()
    return Object.entries(vault.entries)
      .filter(([name]) => !prefix || name.startsWith(prefix))
      .map(([name, entry]) => ({
        name,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
      }))
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key
    try {
      const encoded = await readFile(this.keyPath, 'utf8')
      this.key = Buffer.from(encoded.trim(), 'base64')
    } catch {
      await mkdir(dirname(this.keyPath), { recursive: true })
      this.key = randomBytes(32)
      await writeFile(this.keyPath, this.key.toString('base64'), { mode: 0o600 })
      await chmod(this.keyPath, 0o600)
    }
    if (this.key.length !== 32) throw new Error('corrupt secret key file')
    return this.key
  }

  private async readVault(): Promise<VaultFile> {
    try {
      const raw = await readFile(this.vaultPath, 'utf8')
      const parsed = JSON.parse(raw) as VaultFile
      if (parsed.version !== 1 || typeof parsed.entries !== 'object') {
        throw new Error('unsupported vault format')
      }
      return { version: 1, entries: { ...parsed.entries } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} }
      }
      throw error
    }
  }

  private async writeVault(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.vaultPath), { recursive: true })
    await writeFile(this.vaultPath, JSON.stringify(vault, null, 2), { mode: 0o600 })
    await chmod(this.vaultPath, 0o600)
  }
}
