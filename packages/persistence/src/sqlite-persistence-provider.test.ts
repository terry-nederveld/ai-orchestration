import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqlitePersistenceProvider } from './sqlite-persistence-provider.js'
import { describePersistenceProviderContract } from './testing/persistence-provider-contract.js'

describePersistenceProviderContract(
  'SQLite (:memory:)',
  () => new SqlitePersistenceProvider(':memory:'),
)

describe('SQLite (temp file)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  describePersistenceProviderContract('SQLite (temp file)', () => {
    dir = mkdtempSync(join(tmpdir(), 'overture-persistence-'))
    return new SqlitePersistenceProvider(join(dir, 'overture.sqlite'))
  })
})

describe('SqlitePersistenceProvider', () => {
  it('persists data across connections to the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overture-persistence-'))
    const path = join(dir, 'overture.sqlite')
    try {
      const first = new SqlitePersistenceProvider(path)
      await first.migrate()
      await first.config.set('workflows', 'default-model', 'claude-sonnet')
      await first.close()

      const second = new SqlitePersistenceProvider(path)
      await second.migrate()
      expect(await second.config.get<string>('workflows', 'default-model')).toBe('claude-sonnet')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes a stable id', () => {
    const provider = new SqlitePersistenceProvider(':memory:')
    expect(provider.id).toBe('sqlite')
  })
})
