/**
 * Default tool registry: aggregates tool providers and resolves the flat tool
 * set offered to an agent, with optional name filtering.
 */

import type { Tool, ToolProvider, ToolRegistry } from '@overture/core'

export class DefaultToolRegistry implements ToolRegistry {
  private readonly providers: ToolProvider[] = []

  register(provider: ToolProvider): void {
    this.providers.push(provider)
  }

  async resolve(names?: readonly string[]): Promise<readonly Tool[]> {
    const tools: Tool[] = []
    const seen = new Set<string>()
    for (const provider of this.providers) {
      // One unreachable provider (e.g. a down MCP server) must not take out
      // tool resolution for everything else.
      let provided: readonly Tool[]
      try {
        provided = await provider.listTools()
      } catch {
        continue
      }
      for (const tool of provided) {
        const name = tool.descriptor.name
        if (seen.has(name)) continue
        if (names && !names.includes(name)) continue
        seen.add(name)
        tools.push(tool)
      }
    }
    return tools
  }
}

/** Convenience ToolProvider over a static tool list. */
export class StaticToolProvider implements ToolProvider {
  constructor(
    readonly id: string,
    private readonly tools: readonly Tool[],
  ) {}

  async listTools(): Promise<readonly Tool[]> {
    return this.tools
  }
}
