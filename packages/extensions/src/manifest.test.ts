import { describe, expect, it } from 'vitest'
import {
  ExtensionManifestError,
  extensionManifestJsonSchema,
  parseExtensionManifest,
} from './manifest.js'

const validManifest = {
  id: 'com.example.security-scan',
  name: 'Security Scan',
  version: '1.2.3',
  description: 'Scans diffs for secrets before commit.',
  provides: {
    tools: ['scan_diff'],
    workflowActions: ['security.scan'],
    hooks: ['before_commit'],
  },
  permissions: ['filesystem.read', 'network.connect'],
}

describe('parseExtensionManifest', () => {
  it('parses a valid manifest', () => {
    const manifest = parseExtensionManifest(validManifest)
    expect(manifest.id).toBe('com.example.security-scan')
    expect(manifest.provides.tools).toEqual(['scan_diff'])
    expect(manifest.permissions).toEqual(['filesystem.read', 'network.connect'])
  })

  it('allows omitting optional fields', () => {
    const manifest = parseExtensionManifest({
      id: 'com.example.minimal',
      name: 'Minimal',
      version: '0.1.0',
      provides: {},
      permissions: [],
    })
    expect(manifest.description).toBeUndefined()
    expect(manifest.provides).toEqual({})
  })

  it('rejects a non reverse-DNS id', () => {
    expect(() => parseExtensionManifest({ ...validManifest, id: 'security-scan' })).toThrow(
      ExtensionManifestError,
    )
  })

  it('rejects an invalid semver version', () => {
    expect(() => parseExtensionManifest({ ...validManifest, version: 'v1' })).toThrow(
      ExtensionManifestError,
    )
  })

  it('rejects an unknown hook point', () => {
    expect(() =>
      parseExtensionManifest({
        ...validManifest,
        provides: { ...validManifest.provides, hooks: ['before_lunch'] },
      }),
    ).toThrow(ExtensionManifestError)
  })

  it('rejects an unknown permission capability', () => {
    expect(() =>
      parseExtensionManifest({ ...validManifest, permissions: ['filesystem.read', 'time.travel'] }),
    ).toThrow(ExtensionManifestError)
  })

  it('rejects unknown top-level fields', () => {
    expect(() => parseExtensionManifest({ ...validManifest, extra: true })).toThrow(
      ExtensionManifestError,
    )
  })

  it('aggregates every problem found, not just the first', () => {
    try {
      parseExtensionManifest({ id: 'bad id', name: '', version: 'nope', provides: {} })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionManifestError)
      const issues = (error as ExtensionManifestError).issues
      expect(issues.length).toBeGreaterThan(1)
      expect(issues.some((issue) => issue.path === 'id')).toBe(true)
      expect(issues.some((issue) => issue.path === 'name')).toBe(true)
      expect(issues.some((issue) => issue.path === 'version')).toBe(true)
      expect(issues.some((issue) => issue.path === 'permissions')).toBe(true)
    }
  })

  it('exposes a usable JSON Schema for the manifest format', () => {
    expect(extensionManifestJsonSchema).toBeTypeOf('object')
    expect(extensionManifestJsonSchema.type).toBe('object')
  })
})
