import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, mergeLayers, validateConfigObject } from './layers.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overture-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mergeLayers', () => {
  it('merges nested objects and replaces arrays and scalars', () => {
    const merged = mergeLayers(
      { a: { x: 1, y: 2 }, list: [1, 2], flag: true },
      { a: { y: 3, z: 4 }, list: [9], flag: false },
    )
    expect(merged).toEqual({ a: { x: 1, y: 3, z: 4 }, list: [9], flag: false })
  })
})

describe('loadConfig', () => {
  it('returns validated defaults with no files present', async () => {
    const { config, layers } = await loadConfig({ userConfigPath: join(dir, 'missing.yaml') })
    expect(layers).toHaveLength(0)
    expect(config.orchestrator.maxConcurrentRuns).toBe(2)
    expect(config.permissions.defaultEffect).toBe('deny')
    expect(config.daemon.port).toBe(43117)
  })

  it('applies user < project < overrides precedence', async () => {
    const userPath = join(dir, 'user.yaml')
    await writeFile(
      userPath,
      [
        'orchestrator: { maxConcurrentRuns: 5 }',
        'workspaces: { defaultStrategy: git-clone }',
        'routing: { defaultProfile: planner, profiles: { planner: { executor: native } } }',
      ].join('\n'),
    )
    const projectDir = join(dir, 'project')
    await mkdir(join(projectDir, '.overture'), { recursive: true })
    await writeFile(
      join(projectDir, '.overture', 'config.yaml'),
      'orchestrator: { maxConcurrentRuns: 3 }\n',
    )

    const { config } = await loadConfig({
      userConfigPath: userPath,
      projectDir,
      overrides: { orchestrator: { pollIntervalMs: 1000 } },
    })
    expect(config.orchestrator.maxConcurrentRuns).toBe(3)
    expect(config.orchestrator.pollIntervalMs).toBe(1000)
    expect(config.workspaces.defaultStrategy).toBe('git-clone')
    expect(config.routing.defaultProfile).toBe('planner')
  })

  it('reports schema violations with paths', async () => {
    const userPath = join(dir, 'user.yaml')
    await writeFile(userPath, 'daemon: { port: 999999 }\nunknown_key: 1\n')
    await expect(loadConfig({ userConfigPath: userPath })).rejects.toThrow(ConfigError)
    try {
      await loadConfig({ userConfigPath: userPath })
    } catch (error) {
      const message = (error as ConfigError).message
      expect(message).toContain('daemon.port')
    }
  })

  it('rejects invalid YAML with a helpful error', async () => {
    const userPath = join(dir, 'user.yaml')
    await writeFile(userPath, 'a: [unclosed\n')
    await expect(loadConfig({ userConfigPath: userPath })).rejects.toThrow(ConfigError)
  })

  it('treats an empty file as an empty layer', async () => {
    const userPath = join(dir, 'user.yaml')
    await writeFile(userPath, '')
    const { config, layers } = await loadConfig({ userConfigPath: userPath })
    expect(layers).toHaveLength(1)
    expect(config.orchestrator.claimant).toBe('overture')
  })
})

describe('validateConfigObject', () => {
  it('returns no issues for a valid document', () => {
    expect(validateConfigObject({ budgets: { default: { maxTokens: 1000 } } })).toEqual([])
  })

  it('lists issues for an invalid document', () => {
    const issues = validateConfigObject({
      budgets: { default: { maxTokens: -1 } },
      mcp: { servers: [{ name: 's', transport: 'stdio' }] },
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.join('\n')).toContain('budgets.default.maxTokens')
  })
})
