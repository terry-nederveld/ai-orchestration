import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryExtensionProvider } from './directory-provider.js'
import { RecordingLogger } from './test-logger.js'

const HEALTHY_MANIFEST = {
  id: 'com.example.healthy',
  name: 'Healthy Extension',
  version: '1.0.0',
  provides: {
    tools: ['ping', 'over_permissioned'],
    workflowActions: ['noop.action'],
    hooks: ['before_commit'],
  },
  permissions: ['filesystem.read'],
}

const HEALTHY_INDEX = `
export function activate(api) {
  return {
    tools: [
      {
        descriptor: { name: 'ping', description: 'pings', inputSchema: {} },
        requiredPermissions: [],
        execute: async () => ({ content: 'pong' }),
      },
      {
        descriptor: { name: 'over_permissioned', description: 'too much', inputSchema: {} },
        requiredPermissions: ['network.connect'],
        execute: async () => ({ content: 'nope' }),
      },
      {
        descriptor: { name: 'undeclared_tool', description: 'sneaky', inputSchema: {} },
        requiredPermissions: [],
        execute: async () => ({ content: 'sneaky' }),
      },
    ],
    workflowActions: [
      { id: 'noop.action', execute: async () => ({}) },
      { id: 'undeclared.action', execute: async () => ({}) },
    ],
    hooks: [
      { point: 'before_commit', handler: async () => ({ action: 'continue' }) },
      { point: 'after_commit', handler: async () => ({ action: 'continue' }) },
    ],
  }
}
`

async function writeExtension(
  rootDir: string,
  dirName: string,
  manifest: unknown,
  indexJs: string,
) {
  const extDir = path.join(rootDir, dirName)
  await mkdir(extDir, { recursive: true })
  await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(path.join(extDir, 'index.js'), indexJs)
}

describe('DirectoryExtensionProvider', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'ext-provider-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('discovers valid manifests and skips invalid ones with a warning', async () => {
    await writeExtension(rootDir, 'healthy', HEALTHY_MANIFEST, HEALTHY_INDEX)
    await writeExtension(
      rootDir,
      'bad-schema',
      { id: 'not-reverse-dns', name: '', version: 'x' },
      '',
    )
    await mkdir(path.join(rootDir, 'bad-json'), { recursive: true })
    await writeFile(path.join(rootDir, 'bad-json', 'manifest.json'), '{ not json')
    await mkdir(path.join(rootDir, 'no-manifest'), { recursive: true })

    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })

    const manifests = await provider.discover()
    expect(manifests.map((m) => m.id)).toEqual(['com.example.healthy'])
    expect(logger.entries.filter((e) => e.level === 'warn')).toHaveLength(2)
  })

  it('loads an extension, enforcing manifest honesty and permission limits', async () => {
    await writeExtension(rootDir, 'healthy', HEALTHY_MANIFEST, HEALTHY_INDEX)
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })

    const extension = await provider.load('com.example.healthy')

    expect(extension.tools?.map((t) => t.descriptor.name)).toEqual(['ping'])
    expect(extension.tools?.[0]?.requiredPermissions).toEqual(['filesystem.read'])

    expect(extension.workflowActions?.map((a) => a.id)).toEqual(['noop.action'])

    expect(extension.hooks?.map((h) => h.point)).toEqual(['before_commit'])

    const warnings = logger.entries.filter((e) => e.level === 'warn')
    expect(
      warnings.some(
        (w) => w.message.includes('undeclared tool') && w.fields?.tool === 'undeclared_tool',
      ),
    ).toBe(true)
    expect(
      warnings.some(
        (w) => w.message.includes('outside its manifest') && w.fields?.tool === 'over_permissioned',
      ),
    ).toBe(true)
    expect(
      warnings.some(
        (w) =>
          w.message.includes('undeclared workflow action') &&
          w.fields?.action === 'undeclared.action',
      ),
    ).toBe(true)
    expect(
      warnings.some(
        (w) => w.message.includes('undeclared hook') && w.fields?.point === 'after_commit',
      ),
    ).toBe(true)
  })

  it('preserves a tool-declared subset of the manifest permissions', async () => {
    const manifest = {
      id: 'com.example.subset',
      name: 'Subset',
      version: '1.0.0',
      provides: { tools: ['scoped'] },
      permissions: ['filesystem.read', 'network.connect'],
    }
    const indexJs = `
      export function activate() {
        return {
          tools: [
            {
              descriptor: { name: 'scoped', description: 'reads only', inputSchema: {} },
              requiredPermissions: ['filesystem.read'],
              execute: async () => ({ content: 'ok' }),
            },
          ],
        }
      }
    `
    await writeExtension(rootDir, 'subset', manifest, indexJs)
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })

    const extension = await provider.load('com.example.subset')
    expect(extension.tools?.[0]?.requiredPermissions).toEqual(['filesystem.read'])
  })

  it('throws when loading an id that does not exist', async () => {
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    await expect(provider.load('com.example.missing')).rejects.toThrow('extension not found')
  })

  it('throws when the entry module has no activate export', async () => {
    await writeExtension(rootDir, 'no-activate', HEALTHY_MANIFEST, 'export const notActivate = 1')
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    await expect(provider.load('com.example.healthy')).rejects.toThrow('does not export activate')
  })
})
