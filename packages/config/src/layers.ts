/**
 * Layered configuration loading with deterministic precedence:
 *
 *   built-in defaults  <  user config  <  project config  <  run overrides
 *
 * Merge semantics: plain objects merge deeply; arrays and scalars replace.
 * Each layer is validated in isolation only for shape (partial), and the
 * merged result is validated against the full schema.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { type OvertureConfig, overtureConfigSchema } from './schema.js'

export interface ConfigLayer {
  readonly name: string
  readonly path?: string
  readonly values: Record<string, unknown>
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.join('\n')}` : message)
    this.name = 'ConfigError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge: objects merge, arrays and scalars replace. */
export function mergeLayers(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = mergeLayers(existing, value)
    } else {
      result[key] = value
    }
  }
  return result
}

/** Default locations. XDG-style on every platform, intentionally boring. */
export function defaultUserConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'overture', 'config.yaml')
}

export function projectConfigPath(projectDir: string): string {
  return join(projectDir, '.overture', 'config.yaml')
}

async function readYamlLayer(name: string, path: string): Promise<ConfigLayer | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let values: unknown
  try {
    values = parseYaml(raw)
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${path}`, [
      error instanceof Error ? error.message : String(error),
    ])
  }
  if (values === null || values === undefined) return { name, path, values: {} }
  if (!isPlainObject(values)) {
    throw new ConfigError(`configuration in ${path} must be a mapping`)
  }
  return { name, path, values }
}

export interface LoadConfigOptions {
  readonly userConfigPath?: string
  readonly projectDir?: string
  readonly overrides?: Record<string, unknown>
}

export interface LoadedConfig {
  readonly config: OvertureConfig
  readonly layers: readonly ConfigLayer[]
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const layers: ConfigLayer[] = []

  const userLayer = await readYamlLayer('user', options.userConfigPath ?? defaultUserConfigPath())
  if (userLayer) layers.push(userLayer)

  if (options.projectDir) {
    const projectLayer = await readYamlLayer('project', projectConfigPath(options.projectDir))
    if (projectLayer) layers.push(projectLayer)
  }

  if (options.overrides && Object.keys(options.overrides).length > 0) {
    layers.push({ name: 'overrides', values: options.overrides })
  }

  let merged: Record<string, unknown> = {}
  for (const layer of layers) {
    merged = mergeLayers(merged, layer.values)
  }

  try {
    const config = overtureConfigSchema.parse(merged)
    return { config, layers }
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(
        'invalid configuration',
        error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      )
    }
    throw error
  }
}

/** Validate a single configuration document (e.g. for `overture config validate`). */
export function validateConfigObject(values: unknown): readonly string[] {
  const result = overtureConfigSchema.safeParse(values ?? {})
  if (result.success) return []
  return result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}
