import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { HookRegistry, Tool, ToolProvider, WorkflowAction } from '@overture/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryExtensionProvider } from './directory-provider.js'
import { DefaultHookRegistry } from './hook-registry.js'
import { ExtensionHost } from './host.js'
import { RecordingLogger } from './test-logger.js'

const HEALTHY_MANIFEST = {
  id: 'com.example.healthy',
  name: 'Healthy Extension',
  version: '1.0.0',
  provides: {
    tools: ['ping', 'sneaky'],
    workflowActions: ['noop.action'],
    hooks: ['before_commit'],
  },
  permissions: ['filesystem.read'],
}

const HEALTHY_INDEX = `
export function activate() {
  return {
    tools: [
      {
        descriptor: { name: 'ping', description: 'pings', inputSchema: {} },
        requiredPermissions: [],
        execute: async () => ({ content: 'pong' }),
      },
      {
        descriptor: { name: 'sneaky', description: 'wants too much', inputSchema: {} },
        requiredPermissions: ['secret.read'],
        execute: async () => ({ content: 'nope' }),
      },
    ],
    workflowActions: [{ id: 'noop.action', execute: async () => ({}) }],
    hooks: [{ point: 'before_commit', handler: async () => ({ action: 'continue' }) }],
  }
}
`

const CRASHING_MANIFEST = {
  id: 'com.example.crashy',
  name: 'Crashy Extension',
  version: '1.0.0',
  provides: {},
  permissions: [],
}

const CRASHING_INDEX = `
export function activate() {
  throw new Error('extension init blew up')
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

class RecordingToolRegistry {
  readonly providers: ToolProvider[] = []
  register(provider: ToolProvider): void {
    this.providers.push(provider)
  }
}

describe('ExtensionHost', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'ext-host-'))
    await writeExtension(rootDir, 'healthy', HEALTHY_MANIFEST, HEALTHY_INDEX)
    await writeExtension(rootDir, 'crashy', CRASHING_MANIFEST, CRASHING_INDEX)
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('loads healthy extensions and isolates a crashing one', async () => {
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    const hookRegistry: HookRegistry = new DefaultHookRegistry({ logger })
    const toolRegistry = new RecordingToolRegistry()
    const actions: WorkflowAction[] = []

    const host = new ExtensionHost({
      provider,
      hookRegistry,
      toolRegistry,
      actionSink: (contributed) => actions.push(...contributed),
      logger,
    })

    const summary = await host.loadAll()

    expect(summary.loaded).toEqual(['com.example.healthy'])
    expect(summary.failed).toEqual([{ id: 'com.example.crashy', error: 'extension init blew up' }])
  })

  it('registers only the manifest-honest, permission-valid tools into the tool registry', async () => {
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    const hookRegistry = new DefaultHookRegistry({ logger })
    const toolRegistry = new RecordingToolRegistry()

    const host = new ExtensionHost({ provider, hookRegistry, toolRegistry, logger })
    await host.loadAll()

    expect(toolRegistry.providers).toHaveLength(1)
    const [toolProvider] = toolRegistry.providers
    const tools: readonly Tool[] = (await toolProvider?.listTools()) ?? []
    expect(tools.map((t) => t.descriptor.name)).toEqual(['ping'])
  })

  it('registers hooks with the extension id as source', async () => {
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    const hookRegistry = new DefaultHookRegistry({ logger })

    const host = new ExtensionHost({ provider, hookRegistry, logger })
    await host.loadAll()

    const outcome = await hookRegistry.run({ point: 'before_commit', payload: {} })
    expect(outcome.action).toBe('continue')

    const unregister = hookRegistry.register(
      'before_commit',
      async () => ({ action: 'block' }),
      'later',
    )
    const blocked = await hookRegistry.run({ point: 'before_commit', payload: {} })
    expect(blocked.action).toBe('block')
    unregister()
  })

  it('forwards workflow actions to the action sink', async () => {
    const logger = new RecordingLogger()
    const provider = new DirectoryExtensionProvider({ id: 'test', rootDir, logger })
    const hookRegistry = new DefaultHookRegistry({ logger })
    const actions: WorkflowAction[] = []

    const host = new ExtensionHost({
      provider,
      hookRegistry,
      actionSink: (contributed) => actions.push(...contributed),
      logger,
    })
    await host.loadAll()

    expect(actions.map((a) => a.id)).toEqual(['noop.action'])
  })
})
