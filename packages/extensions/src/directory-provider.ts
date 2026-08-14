/**
 * `ExtensionProvider` that discovers extensions laid out on disk as
 * `<ext-dir>/manifest.json` + `<ext-dir>/index.js` (ESM). Loading enforces
 * manifest honesty: an extension may only contribute tools, workflow
 * actions, and hooks it declared in `provides`; anything else is dropped.
 * It also enforces the permission model: a contributed tool with no
 * declared permissions inherits the manifest's, and any tool that declares
 * a permission outside the manifest's `permissions` list is rejected.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Extension,
  ExtensionManifest,
  ExtensionProvider,
  HookHandler,
  HookPoint,
  Logger,
  Tool,
  WorkflowAction,
} from '@overture/core'
import { parseExtensionManifest } from './manifest.js'

const MANIFEST_FILE = 'manifest.json'
const ENTRY_FILE = 'index.js'

export interface ExtensionApi {
  readonly manifest: ExtensionManifest
  readonly logger: Logger
}

export interface ExtensionExports {
  readonly tools?: readonly Tool[]
  readonly workflowActions?: readonly WorkflowAction[]
  readonly hooks?: ReadonlyArray<{ readonly point: HookPoint; readonly handler: HookHandler }>
}

export type ExtensionActivate = (api: ExtensionApi) => ExtensionExports | Promise<ExtensionExports>

export interface DirectoryExtensionProviderOptions {
  readonly id: string
  readonly rootDir: string
  readonly logger: Logger
}

export class DirectoryExtensionProvider implements ExtensionProvider {
  readonly id: string
  private readonly rootDir: string
  private readonly logger: Logger

  constructor(options: DirectoryExtensionProviderOptions) {
    this.id = options.id
    this.rootDir = options.rootDir
    this.logger = options.logger
  }

  async discover(): Promise<readonly ExtensionManifest[]> {
    const manifests: ExtensionManifest[] = []
    for (const dir of await this.listExtensionDirs()) {
      const manifest = await this.readManifest(dir)
      if (manifest !== undefined) manifests.push(manifest)
    }
    return manifests
  }

  async load(id: string): Promise<Extension> {
    for (const dir of await this.listExtensionDirs()) {
      const manifest = await this.readManifest(dir)
      if (manifest === undefined || manifest.id !== id) continue
      return this.loadFromDir(dir, manifest)
    }
    throw new Error(`extension not found: ${id}`)
  }

  private async listExtensionDirs(): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.rootDir, entry.name))
  }

  private async readManifest(dir: string): Promise<ExtensionManifest | undefined> {
    const manifestPath = path.join(dir, MANIFEST_FILE)
    let raw: string
    try {
      raw = await readFile(manifestPath, 'utf8')
    } catch {
      return undefined
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      this.logger.warn('invalid extension manifest JSON; skipping', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }

    try {
      return parseExtensionManifest(json)
    } catch (error) {
      this.logger.warn('invalid extension manifest; skipping', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async loadFromDir(dir: string, manifest: ExtensionManifest): Promise<Extension> {
    const entryPath = path.join(dir, ENTRY_FILE)
    const moduleExports = (await import(pathToFileURL(entryPath).href)) as {
      activate?: ExtensionActivate
    }
    if (typeof moduleExports.activate !== 'function') {
      throw new Error(`extension ${manifest.id} does not export activate()`)
    }

    const extensionLogger = this.logger.child({ extension: manifest.id })
    const exports = await moduleExports.activate({ manifest, logger: extensionLogger })
    return applyManifestHonesty(manifest, exports, extensionLogger)
  }
}

function applyManifestHonesty(
  manifest: ExtensionManifest,
  exports: ExtensionExports,
  logger: Logger,
): Extension {
  const declaredTools = new Set(manifest.provides.tools ?? [])
  const declaredActions = new Set(manifest.provides.workflowActions ?? [])
  const declaredHooks = new Set<HookPoint>(manifest.provides.hooks ?? [])
  const allowedPermissions = new Set(manifest.permissions)

  const tools: Tool[] = []
  for (const tool of exports.tools ?? []) {
    const name = tool.descriptor.name
    if (!declaredTools.has(name)) {
      logger.warn('extension contributed undeclared tool; dropping', {
        extension: manifest.id,
        tool: name,
      })
      continue
    }

    const requiredPermissions =
      tool.requiredPermissions.length > 0 ? tool.requiredPermissions : manifest.permissions
    const undeclared = requiredPermissions.filter(
      (permission) => !allowedPermissions.has(permission),
    )
    if (undeclared.length > 0) {
      logger.warn('extension tool requires permissions outside its manifest; rejecting', {
        extension: manifest.id,
        tool: name,
        undeclared,
      })
      continue
    }

    tools.push(tool.requiredPermissions.length > 0 ? tool : { ...tool, requiredPermissions })
  }

  const workflowActions: WorkflowAction[] = []
  for (const action of exports.workflowActions ?? []) {
    if (!declaredActions.has(action.id)) {
      logger.warn('extension contributed undeclared workflow action; dropping', {
        extension: manifest.id,
        action: action.id,
      })
      continue
    }
    workflowActions.push(action)
  }

  const hooks: Array<{ point: HookPoint; handler: HookHandler }> = []
  for (const hook of exports.hooks ?? []) {
    if (!declaredHooks.has(hook.point)) {
      logger.warn('extension contributed undeclared hook; dropping', {
        extension: manifest.id,
        point: hook.point,
      })
      continue
    }
    hooks.push(hook)
  }

  return {
    manifest,
    ...(tools.length > 0 ? { tools } : {}),
    ...(workflowActions.length > 0 ? { workflowActions } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
  }
}
