/**
 * Behavioral contract every SecretProvider implementation must satisfy:
 * round-tripping values, overwrite semantics, deletion, and prefix-filtered
 * listing that never exposes raw values.
 */

import type { SecretProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'

export function describeSecretProviderContract(
  name: string,
  factory: () => SecretProvider | Promise<SecretProvider>,
): void {
  describe(`SecretProvider contract: ${name}`, () => {
    it('returns undefined for a secret that was never set', async () => {
      const provider = await factory()
      expect(await provider.get('contract/does-not-exist')).toBeUndefined()
    })

    it('round-trips a stored value', async () => {
      const provider = await factory()
      await provider.set('contract/roundtrip', 's3cr3t')
      expect(await provider.get('contract/roundtrip')).toBe('s3cr3t')
    })

    it('set() overwrites an existing value', async () => {
      const provider = await factory()
      await provider.set('contract/overwrite', 'first')
      await provider.set('contract/overwrite', 'second')
      expect(await provider.get('contract/overwrite')).toBe('second')
    })

    it('delete() removes the value', async () => {
      const provider = await factory()
      await provider.set('contract/deleteme', 'value')
      await provider.delete('contract/deleteme')
      expect(await provider.get('contract/deleteme')).toBeUndefined()
    })

    it('list() honors the prefix filter and never carries a value field', async () => {
      const provider = await factory()
      await provider.set('contract/prefix/a', 'value-a')
      await provider.set('contract/other/b', 'value-b')

      const filtered = await provider.list('contract/prefix/')
      expect(filtered.every((m) => m.name.startsWith('contract/prefix/'))).toBe(true)
      expect(filtered.some((m) => m.name === 'contract/prefix/a')).toBe(true)
      expect(filtered.some((m) => m.name === 'contract/other/b')).toBe(false)
      for (const meta of filtered) {
        expect(Object.keys(meta)).not.toContain('value')
      }
    })
  })
}
