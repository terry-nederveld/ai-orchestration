import { describe, expect, it } from 'vitest'
import { describeSecretProviderContract } from './contracts/secret-provider.contract.js'
import { InMemorySecretProvider } from './secret-provider.js'

describeSecretProviderContract('InMemorySecretProvider', () => new InMemorySecretProvider())

describe('InMemorySecretProvider', () => {
  it('preserves createdAt across updates while bumping updatedAt', async () => {
    const provider = new InMemorySecretProvider()
    await provider.set('k', 'v1')
    const [firstMeta] = await provider.list()
    await provider.set('k', 'v2')
    const [secondMeta] = await provider.list()
    expect(secondMeta?.createdAt).toEqual(firstMeta?.createdAt)
  })

  it('is scoped per instance', async () => {
    const a = new InMemorySecretProvider('a')
    const b = new InMemorySecretProvider('b')
    await a.set('shared-key', 'from-a')
    expect(await b.get('shared-key')).toBeUndefined()
  })
})
