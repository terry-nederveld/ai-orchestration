import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConventionInstructionProvider,
  createDefaultInstructionProviders,
} from './instruction-providers.js'

let repo: string

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(repo, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, content)
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'overture-resolution-'))
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('ConventionInstructionProvider', () => {
  it('discovers repository-root convention files with scope, precedence, and provenance', async () => {
    await write('CLAUDE.md', '# Claude rules')
    await write('AGENTS.md', '# Agents rules')
    await write('.github/copilot-instructions.md', '# Copilot rules')

    const provider = new ConventionInstructionProvider()
    const documents = await provider.discover({ repositoryPaths: [repo] })

    expect(documents.map((d) => d.source).sort()).toEqual([
      '.github/copilot-instructions.md',
      'AGENTS.md',
      'CLAUDE.md',
    ])
    const claude = documents.find((d) => d.source === 'CLAUDE.md')
    expect(claude).toMatchObject({
      scope: 'repository',
      precedence: 50,
      relativePath: 'CLAUDE.md',
      content: '# Claude rules',
      providerId: 'convention-instructions',
      path: path.join(repo, 'CLAUDE.md'),
    })
    expect(claude?.contentHash).toBe(createHash('sha256').update('# Claude rules').digest('hex'))
    const copilot = documents.find((d) => d.source === '.github/copilot-instructions.md')
    expect(copilot?.relativePath).toBe('.github/copilot-instructions.md')
    expect(copilot?.scope).toBe('repository')
  })

  it('discovers directory files for focus directories and ancestors, deeper precedence wins', async () => {
    await write('CLAUDE.md', 'root')
    await write('src/CLAUDE.md', 'src')
    await write('src/api/AGENTS.md', 'api')

    const provider = new ConventionInstructionProvider()
    const documents = await provider.discover({
      repositoryPaths: [repo],
      focusDirectories: ['src/api'],
    })

    const byRelative = new Map(documents.map((d) => [d.relativePath, d]))
    expect(byRelative.get('CLAUDE.md')).toMatchObject({ scope: 'repository', precedence: 50 })
    expect(byRelative.get('src/CLAUDE.md')).toMatchObject({ scope: 'directory', precedence: 71 })
    expect(byRelative.get('src/api/AGENTS.md')).toMatchObject({
      scope: 'directory',
      precedence: 72,
      source: 'AGENTS.md',
    })
  })

  it('deduplicates overlapping focus directories', async () => {
    await write('src/CLAUDE.md', 'src')

    const provider = new ConventionInstructionProvider()
    const documents = await provider.discover({
      repositoryPaths: [repo],
      focusDirectories: ['src/api', 'src', 'src/lib'],
    })

    expect(documents.filter((d) => d.relativePath === 'src/CLAUDE.md')).toHaveLength(1)
  })

  it('truncates files larger than 64KB with a marker and hashes the truncated content', async () => {
    const big = 'a'.repeat(70 * 1024)
    await write('CLAUDE.md', big)

    const provider = new ConventionInstructionProvider()
    const [document] = await provider.discover({ repositoryPaths: [repo] })

    expect(document?.content.endsWith('[truncated: file exceeds 64KB]')).toBe(true)
    expect(document?.content.length).toBeLessThan(big.length)
    expect(document?.contentHash).toBe(
      createHash('sha256')
        .update(document?.content ?? '')
        .digest('hex'),
    )
  })

  it('silently skips missing repositories and unreadable focus directories', async () => {
    const provider = new ConventionInstructionProvider()
    const documents = await provider.discover({
      repositoryPaths: [path.join(repo, 'does-not-exist')],
      focusDirectories: ['also/missing', '../escape', '/absolute'],
    })
    expect(documents).toEqual([])
  })

  it('honors a custom filename list', async () => {
    await write('CLAUDE.md', 'ignored')
    await write('CONVENTIONS.md', 'custom')

    const provider = new ConventionInstructionProvider({ filenames: ['CONVENTIONS.md'] })
    const documents = await provider.discover({ repositoryPaths: [repo] })

    expect(documents).toHaveLength(1)
    expect(documents[0]?.source).toBe('CONVENTIONS.md')
  })
})

describe('createDefaultInstructionProviders', () => {
  it('returns the convention provider', () => {
    const providers = createDefaultInstructionProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0]).toBeInstanceOf(ConventionInstructionProvider)
  })
})
