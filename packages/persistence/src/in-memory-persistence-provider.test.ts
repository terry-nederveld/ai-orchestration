import { asId } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { InMemoryPersistenceProvider } from './in-memory-persistence-provider.js'
import { describePersistenceProviderContract } from './testing/persistence-provider-contract.js'

describePersistenceProviderContract('in-memory', () => new InMemoryPersistenceProvider())

describe('InMemoryPersistenceProvider', () => {
  it('exposes a stable id', () => {
    expect(new InMemoryPersistenceProvider().id).toBe('in-memory')
  })

  it('does not let callers mutate stored state through returned references', async () => {
    const provider = new InMemoryPersistenceProvider()
    const snapshot = {
      sessionId: asId<'session'>('session-1'),
      runId: asId<'run'>('run-1'),
      provider: 'anthropic',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    await provider.sessions.save(snapshot)

    const loaded = await provider.sessions.get(snapshot.sessionId)
    expect(loaded).toBeDefined()
    // Mutating the array returned by get() must not affect what's stored.
    const mutableMessages = loaded?.messages as unknown[]
    mutableMessages.push({ role: 'user', content: [] })

    const loadedAgain = await provider.sessions.get(snapshot.sessionId)
    expect(loadedAgain?.messages).toHaveLength(1)
  })
})
