import { join, resolve, sep } from 'node:path'
import { OrchestratorError } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { resolveInsideRoot, toSafeSlug } from './path-safety.js'

describe('toSafeSlug', () => {
  it('passes through already-safe identifiers', () => {
    expect(toSafeSlug('run-123_abc')).toBe('run-123_abc')
  })

  it('strips path traversal sequences entirely', () => {
    const slug = toSafeSlug('../../etc/passwd')
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
  })

  it('strips absolute-path leading separators', () => {
    const slug = toSafeSlug('/etc/passwd')
    expect(slug).not.toContain('/')
  })

  it('throws when nothing safe remains', () => {
    expect(() => toSafeSlug('../..')).toThrow(OrchestratorError)
    expect(() => toSafeSlug('...')).toThrow(OrchestratorError)
  })
})

describe('resolveInsideRoot', () => {
  it('joins segments inside the root', () => {
    const root = resolve('/tmp/overture-root')
    const path = resolveInsideRoot(root, 'run-1')
    expect(path).toBe(join(root, 'run-1'))
    expect(path.startsWith(root + sep)).toBe(true)
  })

  it('never escapes root even for traversal-laden runIds', () => {
    const root = resolve('/tmp/overture-root')
    const path = resolveInsideRoot(root, '../../../etc/passwd')
    expect(path.startsWith(root + sep) || path === root).toBe(true)
  })

  it('never escapes root for absolute-path-looking segments', () => {
    const root = resolve('/tmp/overture-root')
    const path = resolveInsideRoot(root, '/etc/passwd')
    expect(path.startsWith(root + sep) || path === root).toBe(true)
  })
})
