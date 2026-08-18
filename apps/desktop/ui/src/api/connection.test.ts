import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ConnectionEntry,
  entryBaseUrl,
  readHashConnection,
  readLegacyStoredConnection,
  readStoredEntries,
  resolveInitialEntries,
} from './connection'

function setHash(hash: string): void {
  window.location.hash = hash
}

function reset(): void {
  window.__OVERTURE_DAEMON__ = undefined
  window.location.hash = ''
  sessionStorage.clear()
  localStorage.clear()
}

beforeEach(reset)
afterEach(reset)

const office: ConnectionEntry = {
  name: 'Office',
  host: 'runtime.example.com',
  port: 8443,
  token: 'office-token',
  kind: 'remote',
}

describe('entryBaseUrl', () => {
  it('uses http for local connections', () => {
    expect(
      entryBaseUrl({ name: 'Local', host: '127.0.0.1', port: 4756, token: 't', kind: 'local' }),
    ).toBe('http://127.0.0.1:4756')
  })

  it('uses https for remote connections', () => {
    expect(entryBaseUrl(office)).toBe('https://runtime.example.com:8443')
  })

  it('keeps an explicit scheme in the host', () => {
    expect(
      entryBaseUrl({ name: 'X', host: 'http://10.0.0.5', port: 4756, token: 't', kind: 'remote' }),
    ).toBe('http://10.0.0.5:4756')
  })
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
})

describe('readStoredEntries', () => {
  it('reads a stored connection list', () => {
    localStorage.setItem('overture.connections', JSON.stringify([office]))
    expect(readStoredEntries()).toEqual([office])
  })

  it('returns an empty list when nothing is stored', () => {
    expect(readStoredEntries()).toEqual([])
  })

  it('returns an empty list for malformed JSON rather than throwing', () => {
    localStorage.setItem('overture.connections', '{not json')
    expect(readStoredEntries()).toEqual([])
  })

  it('drops entries missing required fields', () => {
    localStorage.setItem(
      'overture.connections',
      JSON.stringify([office, { name: 'broken', host: 'x' }]),
    )
    expect(readStoredEntries()).toEqual([office])
  })
})

describe('resolveInitialEntries', () => {
  it('returns the stored registry when no legacy connection resolves', () => {
    localStorage.setItem('overture.connections', JSON.stringify([office]))
    expect(resolveInitialEntries()).toEqual([office])
  })

  it('turns an injected daemon handle into a connection named Local', () => {
    window.__OVERTURE_DAEMON__ = { baseUrl: 'http://127.0.0.1:1111', token: 'injected' }
    expect(resolveInitialEntries()).toEqual([
      { name: 'Local', host: '127.0.0.1', port: 1111, token: 'injected', kind: 'local' },
    ])
  })

  it('turns hash params into a connection named Local (the v1 fast path)', () => {
    setHash('#port=2222&token=from-hash')
    expect(resolveInitialEntries()).toEqual([
      { name: 'Local', host: '127.0.0.1', port: 2222, token: 'from-hash', kind: 'local' },
    ])
  })

  it('migrates the legacy single stored connection', () => {
    sessionStorage.setItem(
      'overture.connection',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:3333', token: 'from-storage' }),
    )
    expect(readLegacyStoredConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:3333',
      token: 'from-storage',
    })
    expect(resolveInitialEntries()).toEqual([
      { name: 'Local', host: '127.0.0.1', port: 3333, token: 'from-storage', kind: 'local' },
    ])
  })

  it('merges a legacy connection ahead of the stored registry without duplicating it', () => {
    localStorage.setItem('overture.connections', JSON.stringify([office]))
    setHash('#port=2222&token=from-hash')
    expect(resolveInitialEntries()).toEqual([
      { name: 'Local', host: '127.0.0.1', port: 2222, token: 'from-hash', kind: 'local' },
      office,
    ])
  })

  it('skips the legacy connection when the registry already has its base URL', () => {
    const local: ConnectionEntry = {
      name: 'Laptop',
      host: '127.0.0.1',
      port: 2222,
      token: 'kept-token',
      kind: 'local',
    }
    localStorage.setItem('overture.connections', JSON.stringify([local]))
    setHash('#port=2222&token=from-hash')
    expect(resolveInitialEntries()).toEqual([local])
  })

  it('avoids name collisions when merging the legacy connection', () => {
    const named: ConnectionEntry = {
      name: 'Local',
      host: '10.1.1.1',
      port: 4756,
      token: 'other',
      kind: 'remote',
    }
    localStorage.setItem('overture.connections', JSON.stringify([named]))
    setHash('#port=2222&token=from-hash')
    const resolved = resolveInitialEntries()
    expect(resolved[0]?.name).toBe('Local (2222)')
    expect(resolved[1]).toEqual(named)
  })

  it('returns an empty list when nothing resolves, signalling first run', () => {
    expect(resolveInitialEntries()).toEqual([])
  })
})
