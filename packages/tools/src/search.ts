/**
 * Search tools: glob-style file finding and regex content search, implemented
 * with plain filesystem traversal so behavior is identical on every platform.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { PermissionCapability, type Tool } from '@overture/core'
import { containedPath, workspaceRoot } from './paths.js'

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.pnpm-store'])

async function collectFiles(root: string, base: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const queue = [base]
  while (queue.length > 0 && files.length < 20_000 && !signal.aborted) {
    const directory = queue.shift()
    if (!directory) break
    let items: Dirent[]
    try {
      items = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = join(directory, item.name)
      if (item.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(item.name)) queue.push(full)
      } else if (item.isFile()) {
        files.push(relative(root, full))
      }
    }
  }
  return files
}

/** Convert a glob pattern (`**`, `*`, `?`) into a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let regex = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*'
        i += 1
        if (pattern[i + 1] === '/') i += 1
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else if (char !== undefined && '\\^$.|+()[]{}'.includes(char)) {
      regex += `\\${char}`
    } else {
      regex += char
    }
  }
  return new RegExp(`^${regex}$`)
}

interface GlobInput {
  pattern?: string
  path?: string
}

export const globTool: Tool = {
  descriptor: {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "src/**/*.ts").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search from; default workspace root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead],
  async execute(input, context) {
    const { pattern, path = '.' } = (input ?? {}) as GlobInput
    if (!pattern) return { content: 'error: pattern is required', isError: true }
    const root = workspaceRoot(context)
    const base = containedPath(root, path)
    const files = await collectFiles(root, base, context.signal)
    const matcher = globToRegExp(pattern)
    const matches = files.filter((file) => matcher.test(file)).slice(0, 500)
    return { content: matches.length > 0 ? matches.join('\n') : 'no matches' }
  },
}

interface GrepInput {
  pattern?: string
  path?: string
  file_glob?: string
  max_results?: number
}

export const grepTool: Tool = {
  descriptor: {
    name: 'grep',
    description: 'Search file contents with a regular expression; returns file:line matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Directory to search from; default workspace root.' },
        file_glob: { type: 'string', description: 'Restrict to files matching this glob.' },
        max_results: { type: 'number', description: 'Default 100.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead],
  async execute(input, context) {
    const { pattern, path = '.', file_glob, max_results = 100 } = (input ?? {}) as GrepInput
    if (!pattern) return { content: 'error: pattern is required', isError: true }
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      return {
        content: `error: invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
    const root = workspaceRoot(context)
    const base = containedPath(root, path)
    let files = await collectFiles(root, base, context.signal)
    if (file_glob) {
      const matcher = globToRegExp(file_glob)
      files = files.filter((file) => matcher.test(file))
    }
    const results: string[] = []
    for (const file of files) {
      if (results.length >= max_results || context.signal.aborted) break
      let raw: string
      try {
        raw = await readFile(join(root, file), 'utf8')
      } catch {
        continue
      }
      if (raw.includes('\0')) continue
      const lines = raw.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line !== undefined && regex.test(line)) {
          results.push(`${file}:${index + 1}: ${line.trim().slice(0, 200)}`)
          if (results.length >= max_results) break
        }
      }
    }
    return { content: results.length > 0 ? results.join('\n') : 'no matches' }
  },
}
