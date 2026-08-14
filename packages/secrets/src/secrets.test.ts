import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EncryptedFileSecretProvider } from './encrypted-file.js'
import { resolveSecretProvider } from './platform.js'
import { SecretRedactor } from './redaction.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overture-secrets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('EncryptedFileSecretProvider', () => {
  it('round-trips secrets', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    await provider.set('provider/anthropic/api-key', 'sk-test-123')
    expect(await provider.get('provider/anthropic/api-key')).toBe('sk-test-123')
  })

  it('returns undefined for missing secrets', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    expect(await provider.get('missing')).toBeUndefined()
  })

  it('overwrites and deletes', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    await provider.set('a', 'one')
    await provider.set('a', 'two')
    expect(await provider.get('a')).toBe('two')
    await provider.delete('a')
    expect(await provider.get('a')).toBeUndefined()
    await provider.delete('a')
  })

  it('lists names with prefix filtering, never values', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    await provider.set('provider/anthropic/api-key', 'v1')
    await provider.set('provider/openai/api-key', 'v2')
    await provider.set('work/github/token', 'v3')
    const all = await provider.list()
    expect(all.map((entry) => entry.name).sort()).toEqual([
      'provider/anthropic/api-key',
      'provider/openai/api-key',
      'work/github/token',
    ])
    const filtered = await provider.list('provider/')
    expect(filtered).toHaveLength(2)
    expect(JSON.stringify(all)).not.toContain('v1')
  })

  it('does not store plaintext in the vault file', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    await provider.set('key', 'super-secret-value')
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'secrets.vault.json'), 'utf8'),
    )
    expect(raw).not.toContain('super-secret-value')
  })

  it('persists across provider instances (key reuse)', async () => {
    const first = new EncryptedFileSecretProvider(dir)
    await first.set('k', 'v')
    const second = new EncryptedFileSecretProvider(dir)
    expect(await second.get('k')).toBe('v')
  })

  it('creates key and vault with restrictive permissions', async () => {
    const provider = new EncryptedFileSecretProvider(dir)
    await provider.set('k', 'v')
    const keyMode = (await stat(join(dir, 'secrets.key'))).mode & 0o777
    const vaultMode = (await stat(join(dir, 'secrets.vault.json'))).mode & 0o777
    expect(keyMode).toBe(0o600)
    expect(vaultMode).toBe(0o600)
  })
})

describe('resolveSecretProvider', () => {
  it('falls back to encrypted file on unknown platforms', async () => {
    const provider = await resolveSecretProvider({
      fallbackDirectory: dir,
      platform: 'freebsd',
    })
    expect(provider.id).toBe('encrypted-file')
  })

  it('selects the keychain on darwin when security exists', async () => {
    if (process.platform !== 'darwin') return
    const provider = await resolveSecretProvider({ fallbackDirectory: dir })
    expect(provider.id).toBe('macos-keychain')
  })
})

describe('SecretRedactor', () => {
  it('redacts tracked values', () => {
    const redactor = new SecretRedactor()
    redactor.track('sk-live-abcdef123')
    expect(redactor.redact('calling with sk-live-abcdef123 now')).toBe(
      'calling with [redacted] now',
    )
  })

  it('ignores short or undefined values', () => {
    const redactor = new SecretRedactor()
    redactor.track(undefined)
    redactor.track('abc')
    expect(redactor.redact('abc stays')).toBe('abc stays')
  })
})
