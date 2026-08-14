import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, noopLogger, type ToolExecutionContext } from '@overture/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from './filesystem.js'
import { containedPath, PathEscapeError } from './paths.js'
import { globTool, globToRegExp, grepTool } from './search.js'
import { createRunCommandTool } from './shell.js'

let root: string

const context = (signal?: AbortSignal): ToolExecutionContext => ({
  runId: 'r1',
  sessionId: 's1',
  workspace: {
    id: asId('ws1'),
    strategy: 'temp-directory',
    path: root,
    createdAt: new Date(),
  },
  logger: noopLogger,
  signal: signal ?? new AbortController().signal,
  resolveSecret: async () => undefined,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'overture-tools-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('containedPath', () => {
  it('resolves relative paths inside the root', () => {
    expect(containedPath(root, 'a/b.txt')).toBe(join(root, 'a/b.txt'))
  })

  it('rejects escapes via ..', () => {
    expect(() => containedPath(root, '../outside.txt')).toThrow(PathEscapeError)
  })

  it('rejects absolute paths outside the root', () => {
    expect(() => containedPath(root, '/etc/passwd')).toThrow(PathEscapeError)
  })

  it('rejects prefix-sibling escapes', () => {
    expect(() => containedPath(root, `${root}-sibling/x`)).toThrow(PathEscapeError)
  })
})

describe('filesystem tools', () => {
  it('writes, reads, and edits files', async () => {
    const write = await writeFileTool.execute(
      { path: 'src/hello.ts', content: 'const a = 1\n' },
      context(),
    )
    expect(write.isError).toBeUndefined()

    const read = await readFileTool.execute({ path: 'src/hello.ts' }, context())
    expect(read.content).toContain('1\tconst a = 1')

    const edit = await editFileTool.execute(
      { path: 'src/hello.ts', old_text: 'const a = 1', new_text: 'const a = 2' },
      context(),
    )
    expect(edit.isError).toBeUndefined()
    const after = await readFileTool.execute({ path: 'src/hello.ts' }, context())
    expect(after.content).toContain('const a = 2')
  })

  it('rejects ambiguous edits', async () => {
    await writeFileTool.execute({ path: 'x.txt', content: 'dup\ndup\n' }, context())
    const edit = await editFileTool.execute(
      { path: 'x.txt', old_text: 'dup', new_text: 'once' },
      context(),
    )
    expect(edit.isError).toBe(true)
    expect(edit.content).toContain('2 times')
  })

  it('lists directories with ignored dirs excluded', async () => {
    await writeFileTool.execute({ path: 'src/a.ts', content: 'x' }, context())
    await writeFileTool.execute({ path: 'node_modules/pkg/index.js', content: 'x' }, context())
    const listing = await listDirectoryTool.execute({}, context())
    expect(listing.content).toContain('src/')
    expect(listing.content).not.toContain('node_modules')
  })
})

describe('search tools', () => {
  it('globToRegExp handles ** and *', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false)
    expect(globToRegExp('*.ts').test('b.ts')).toBe(true)
  })

  it('globs and greps workspace files', async () => {
    await writeFileTool.execute(
      { path: 'src/one.ts', content: 'export const alpha = 1\n' },
      context(),
    )
    await writeFileTool.execute({ path: 'src/two.md', content: 'alpha docs\n' }, context())

    const globbed = await globTool.execute({ pattern: 'src/**/*.ts' }, context())
    expect(globbed.content).toBe('src/one.ts')

    const grepped = await grepTool.execute({ pattern: 'alpha', file_glob: '**/*.ts' }, context())
    expect(grepped.content).toContain('src/one.ts:1')
    expect(grepped.content).not.toContain('two.md')
  })

  it('skips binary files in grep', async () => {
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x61]))
    const grepped = await grepTool.execute({ pattern: 'a' }, context())
    expect(grepped.content).toBe('no matches')
  })
})

describe('run_command tool', () => {
  const tool = createRunCommandTool()

  it('captures stdout and exit code', async () => {
    const result = await tool.execute({ command: 'echo hello' }, context())
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('exit code: 0')
    expect(result.content).toContain('hello')
  })

  it('reports non-zero exits as errors', async () => {
    const result = await tool.execute({ command: 'exit 3' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('exit code: 3')
  })

  it('times out runaway commands', async () => {
    const result = await tool.execute({ command: 'sleep 30', timeout_seconds: 1 }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
  }, 10_000)

  it('honors abort signals', async () => {
    const controller = new AbortController()
    const pending = tool.execute({ command: 'sleep 30' }, context(controller.signal))
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('runs in the workspace directory', async () => {
    const result = await tool.execute({ command: 'pwd' }, context())
    const realRoot = await import('node:fs/promises').then((fs) => fs.realpath(root))
    expect(result.content).toContain(realRoot)
  })
})
