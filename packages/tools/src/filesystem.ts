/**
 * Filesystem tools: read, write, edit, list. All paths are workspace-contained
 * and all writes are permission-gated by the runtime's policy check.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { PermissionCapability, type Tool, type ToolExecutionContext } from '@overture/core'
import { containedPath, workspaceRoot } from './paths.js'

const MAX_READ_CHARS = 100_000

interface ReadInput {
  path?: string
  offset?: number
  limit?: number
}

export const readFileTool: Tool = {
  descriptor: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'number', description: '1-based first line to read.' },
        limit: { type: 'number', description: 'Maximum number of lines.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead],
  async execute(input, context) {
    const { path, offset, limit } = (input ?? {}) as ReadInput
    if (!path) return { content: 'error: path is required', isError: true }
    const resolved = containedPath(workspaceRoot(context), path)
    const raw = await readFile(resolved, 'utf8')
    const lines = raw.split('\n')
    const start = Math.max((offset ?? 1) - 1, 0)
    const end = limit ? start + limit : lines.length
    const slice = lines.slice(start, end)
    let body = slice.map((line, index) => `${start + index + 1}\t${line}`).join('\n')
    if (body.length > MAX_READ_CHARS) {
      body = `${body.slice(0, MAX_READ_CHARS)}\n[truncated — use offset/limit to read more]`
    }
    if (end < lines.length) body += `\n[${lines.length - end} more lines]`
    return { content: body }
  },
}

interface WriteInput {
  path?: string
  content?: string
}

export const writeFileTool: Tool = {
  descriptor: {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the given content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemWrite],
  async execute(input, context) {
    const { path, content } = (input ?? {}) as WriteInput
    if (!path || content === undefined) {
      return { content: 'error: path and content are required', isError: true }
    }
    const resolved = containedPath(workspaceRoot(context), path)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')
    return { content: `wrote ${Buffer.byteLength(content)} bytes to ${path}` }
  },
}

interface EditInput {
  path?: string
  old_text?: string
  new_text?: string
  replace_all?: boolean
}

export const editFileTool: Tool = {
  descriptor: {
    name: 'edit_file',
    description:
      'Replace an exact text occurrence in a file. old_text must match exactly once unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace.' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead, PermissionCapability.FilesystemWrite],
  async execute(input, context) {
    const { path, old_text, new_text, replace_all } = (input ?? {}) as EditInput
    if (!path || old_text === undefined || new_text === undefined) {
      return { content: 'error: path, old_text, and new_text are required', isError: true }
    }
    const resolved = containedPath(workspaceRoot(context), path)
    const raw = await readFile(resolved, 'utf8')
    const occurrences = raw.split(old_text).length - 1
    if (occurrences === 0) {
      return { content: `error: old_text not found in ${path}`, isError: true }
    }
    if (occurrences > 1 && !replace_all) {
      return {
        content: `error: old_text matches ${occurrences} times in ${path}; provide more context or set replace_all`,
        isError: true,
      }
    }
    const updated = replace_all
      ? raw.split(old_text).join(new_text)
      : raw.replace(old_text, new_text)
    await writeFile(resolved, updated, 'utf8')
    return { content: `edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})` }
  },
}

interface ListInput {
  path?: string
  depth?: number
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.pnpm-store'])

export const listDirectoryTool: Tool = {
  descriptor: {
    name: 'list_directory',
    description: 'List files and directories in the workspace, recursively up to a depth.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to workspace root; default "."' },
        depth: { type: 'number', description: 'Recursion depth, default 2.' },
      },
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead],
  async execute(input, context) {
    const { path = '.', depth = 2 } = (input ?? {}) as ListInput
    const root = workspaceRoot(context)
    const base = containedPath(root, path)
    const entries: string[] = []
    await walk(base, root, depth, entries, context)
    if (entries.length === 0) return { content: '(empty)' }
    return { content: entries.join('\n') }
  },
}

async function walk(
  directory: string,
  root: string,
  depth: number,
  out: string[],
  context: ToolExecutionContext,
  limit = 500,
): Promise<void> {
  if (depth < 0 || out.length >= limit || context.signal.aborted) return
  const items = await readdir(directory, { withFileTypes: true })
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) {
      out.push('[listing truncated]')
      return
    }
    const full = join(directory, item.name)
    const rel = relative(root, full)
    if (item.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(item.name)) continue
      out.push(`${rel}/`)
      await walk(full, root, depth - 1, out, context, limit)
    } else {
      const info = await stat(full)
      out.push(`${rel} (${info.size}b)`)
    }
  }
}
