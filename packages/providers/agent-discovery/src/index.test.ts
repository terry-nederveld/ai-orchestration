import { describe, expect, it } from 'vitest'
import { discoverLocalAgents, type VersionRunner } from './index.js'

describe('discoverLocalAgents', () => {
  it('reports installed:true with the version for binaries the runner resolves', async () => {
    const runner: VersionRunner = async (binary) => {
      if (binary === 'claude') return 'claude 2.1.232'
      throw new Error('not found')
    }

    const results = await discoverLocalAgents(runner)
    const claude = results.find((r) => r.id === 'claude')
    expect(claude).toEqual({
      id: 'claude',
      binary: 'claude',
      installed: true,
      version: 'claude 2.1.232',
    })
  })

  it('reports installed:false without throwing for binaries the runner rejects', async () => {
    const runner: VersionRunner = async () => {
      throw new Error('ENOENT')
    }

    const results = await discoverLocalAgents(runner)
    expect(results.every((r) => r.installed === false)).toBe(true)
    expect(results.every((r) => r.version === undefined)).toBe(true)
  })

  it('probes every known local agent id independently', async () => {
    const seen: string[] = []
    const runner: VersionRunner = async (binary) => {
      seen.push(binary)
      return 'v1'
    }

    await discoverLocalAgents(runner)
    expect(seen.sort()).toEqual(['claude', 'codex', 'copilot', 'gh', 'ollama'])
  })

  it('resolves each probe independently: one failure does not affect the others', async () => {
    const runner: VersionRunner = async (binary) => {
      if (binary === 'copilot') throw new Error('ENOENT')
      return `${binary}-version`
    }

    const results = await discoverLocalAgents(runner)
    const byId = Object.fromEntries(results.map((r) => [r.id, r]))
    expect(byId.copilot?.installed).toBe(false)
    expect(byId.claude?.installed).toBe(true)
    expect(byId.codex?.installed).toBe(true)
    expect(byId.gh?.installed).toBe(true)
    expect(byId.ollama?.installed).toBe(true)
  })
})
