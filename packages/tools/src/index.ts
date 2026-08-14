import type { Tool, ToolProvider } from '@overture/core'
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from './filesystem.js'
import { globTool, grepTool } from './search.js'
import { createRunCommandTool, type RunCommandOptions } from './shell.js'

export * from './env.js'
export * from './filesystem.js'
export * from './paths.js'
export * from './search.js'
export * from './shell.js'

/** The standard coding tool set offered to native agents. */
export function createCodingToolProvider(options: RunCommandOptions = {}): ToolProvider {
  const tools: readonly Tool[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    createRunCommandTool(options),
  ]
  return {
    id: 'builtin-coding-tools',
    listTools: async () => tools,
  }
}
