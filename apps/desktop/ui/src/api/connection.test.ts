import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHashConnection, readStoredConnection, resolveInitialConnection } from './connection'

function setHash(hash: string): void {
  window.location.hash = hash
}

beforeEach(() => {
  window.__OVERTURE_DAEMON__ = undefined
  window.location.hash = ''
  sessionStorage.clear()
})

afterEach(() => {
  window.__OVERTURE_DAEMON__ = undefined
  window.location.hash = ''
  sessionStorage.clear()
})

describe('readHashConnection', () => {
  it('parses port and token from the URL hash', () => {
    setHash('#port=4756&token=abc123')
    expect(readHashConnection()).toEqual({ baseUrl: 'http://127.0.0.1:4756', token: 'abc123' })
  })

  it('returns undefined when the hash is empty', () => {
    expect(readHashConnection()).toBeUndefined()
  })

  it('returns undefined when only port is present', () => {
    setHash('#port=4756')
    expect(readHashConnection()).toBeUndefined()
  })

  it('returns undefined when only token is present', () => {
    setHash('#token=abc123')
    expect(readHashConnection()).toBeUndefined()
  })
})

describe('readStoredConnection', () => {
  it('reads a previously stored connection', () => {
    sessionStorage.setItem(
      'overture.connection',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:9000', token: 'stored-token' }),
    )
    expect(readStoredConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:9000',
      token: 'stored-token',
    })
  })

  it('returns undefined when nothing is stored', () => {
    expect(readStoredConnection()).toBeUndefined()
  })

  it('returns undefined for malformed JSON rather than throwing', () => {
    sessionStorage.setItem('overture.connection', '{not json')
    expect(readStoredConnection()).toBeUndefined()
  })

  it('returns undefined when the stored value is missing required fields', () => {
    sessionStorage.setItem('overture.connection', JSON.stringify({ baseUrl: 'http://x' }))
    expect(readStoredConnection()).toBeUndefined()
  })
})

describe('resolveInitialConnection priority', () => {
  it('prefers window.__OVERTURE_DAEMON__ over the hash and storage', () => {
    window.__OVERTURE_DAEMON__ = { baseUrl: 'http://127.0.0.1:1111', token: 'injected' }
    setHash('#port=2222&token=from-hash')
    sessionStorage.setItem(
      'overture.connection',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:3333', token: 'from-storage' }),
    )
    expect(resolveInitialConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:1111',
      token: 'injected',
    })
  })

  it('prefers the hash over stored connection when no injected daemon handle exists', () => {
    setHash('#port=2222&token=from-hash')
    sessionStorage.setItem(
      'overture.connection',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:3333', token: 'from-storage' }),
    )
    expect(resolveInitialConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:2222',
      token: 'from-hash',
    })
  })

  it('falls back to sessionStorage when neither the injected handle nor the hash are present', () => {
    sessionStorage.setItem(
      'overture.connection',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:3333', token: 'from-storage' }),
    )
    expect(resolveInitialConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:3333',
      token: 'from-storage',
    })
  })

  it('returns undefined when nothing resolves, signalling the disconnected state', () => {
    expect(resolveInitialConnection()).toBeUndefined()
  })
})
