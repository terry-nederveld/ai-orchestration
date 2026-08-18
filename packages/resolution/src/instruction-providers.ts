/**
 * Convention-file instruction discovery: scans repositories for CLAUDE.md,
 * AGENTS.md, AGENT.md, and .github/copilot-instructions.md at the repository
 * root (scope 'repository', precedence 50) and inside focus directories plus
 * their ancestors (scope 'directory', precedence 70 + depth, deeper wins).
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  InstructionDiscoveryRequest,
  InstructionDocument,
  InstructionProvider,
} from '@overture/core'

/** Convention file locations, relative to the directory being scanned. */
const DEFAULT_CONVENTION_FILES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'AGENT.md',
  '.github/copilot-instructions.md',
]

const REPOSITORY_PRECEDENCE = 50
const DIRECTORY_PRECEDENCE_BASE = 70
const MAX_FILE_BYTES = 64 * 1024
const TRUNCATION_MARKER = '\n[truncated: file exceeds 64KB]'

export interface ConventionInstructionProviderOptions {
  /** Override the convention file list (paths relative to each scanned directory). */
  readonly filenames?: readonly string[]
}

export class ConventionInstructionProvider implements InstructionProvider {
  readonly id = 'convention-instructions'
  private readonly filenames: readonly string[]

  constructor(options: ConventionInstructionProviderOptions = {}) {
    this.filenames = options.filenames ?? DEFAULT_CONVENTION_FILES
  }

  async discover(request: InstructionDiscoveryRequest): Promise<readonly InstructionDocument[]> {
    const byAbsolutePath = new Map<string, InstructionDocument>()
    for (const repositoryPath of request.repositoryPaths) {
      await this.scanDirectory(byAbsolutePath, repositoryPath, [], 'repository')
      for (const focus of request.focusDirectories ?? []) {
        const segments = normalizeFocusDirectory(focus)
        if (!segments) continue
        // Walk from the focus directory up to (but excluding) the repo root,
        // which the repository-scope scan already covered.
        for (let depth = segments.length; depth >= 1; depth -= 1) {
          await this.scanDirectory(
            byAbsolutePath,
            repositoryPath,
            segments.slice(0, depth),
            'directory',
          )
        }
      }
    }
    return [...byAbsolutePath.values()]
  }

  private async scanDirectory(
    byAbsolutePath: Map<string, InstructionDocument>,
    repositoryPath: string,
    segments: readonly string[],
    scope: 'repository' | 'directory',
  ): Promise<void> {
    for (const convention of this.filenames) {
      const relativePath = [...segments, ...convention.split('/')].join('/')
      const absolutePath = path.join(repositoryPath, ...relativePath.split('/'))
      if (byAbsolutePath.has(absolutePath)) continue
      const content = await readFileCapped(absolutePath)
      if (content === undefined) continue
      byAbsolutePath.set(absolutePath, {
        source: convention,
        scope,
        path: absolutePath,
        relativePath,
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        precedence:
          scope === 'repository'
            ? REPOSITORY_PRECEDENCE
            : DIRECTORY_PRECEDENCE_BASE + segments.length,
        providerId: this.id,
      })
    }
  }
}

/** The stock provider set: convention-file scanning only, for now. */
export function createDefaultInstructionProviders(): readonly InstructionProvider[] {
  return [new ConventionInstructionProvider()]
}

/** Splits a repo-relative focus directory into segments; rejects escapes. */
function normalizeFocusDirectory(focus: string): readonly string[] | undefined {
  if (path.isAbsolute(focus)) return undefined
  const segments = path
    .normalize(focus)
    .split(path.sep)
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return undefined
  return segments
}

/** Reads at most MAX_FILE_BYTES; undefined when missing or unreadable. */
async function readFileCapped(filePath: string): Promise<string | undefined> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, 'r')
  } catch {
    return undefined
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return undefined
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    const content = buffer.toString('utf8')
    return stat.size > MAX_FILE_BYTES ? `${content}${TRUNCATION_MARKER}` : content
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
