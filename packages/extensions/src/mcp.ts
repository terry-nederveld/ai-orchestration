/**
 * MCP client integration (docs/adrs/adr-0014.md). `McpToolProvider` exposes a
 * configured MCP server's tools as a core `ToolProvider`. Per the ADR, MCP
 * servers are NOT extensions — they are untrusted external processes/
 * endpoints, routed through the same ToolRegistry/permission pipeline as
 * every other tool source rather than through this package's extension
 * trust model.
 *
 * The dependency on the real `@modelcontextprotocol/sdk` `Client` and
 * transports is confined to `defaultClientFactory`; everything else in this
 * module talks to the small `McpClient` interface below so tests can supply
 * a scripted fake with no real server process or network call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Logger, Tool, ToolExecutionContext, ToolProvider, ToolResult } from '@overture/core'
import { PermissionCapability } from '@overture/core'

/**
 * Structural subset of `packages/config`'s `mcpServerSchema` output that this
 * module needs. Declared locally (rather than depending on `@overture/config`)
 * so this package doesn't take on a dependency edge for a handful of fields;
 * any object shaped like this — including the real `McpServerConfig` — works.
 */
export interface McpServerConfig {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
  readonly env?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
}

export interface McpContentBlock {
  readonly type: string
  readonly text?: string
}

export interface McpCallToolResult {
  readonly content?: readonly McpContentBlock[]
  readonly isError?: boolean
}

export interface McpRemoteTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export interface McpRequestOptions {
  readonly signal?: AbortSignal
}

/**
 * Narrow surface of the SDK's `Client` (bound to one already-built
 * transport) that `McpToolProvider` depends on. `defaultClientFactory`
 * adapts the real SDK client to this shape; tests substitute a scripted
 * fake that never touches a process or the network.
 */
export interface McpClient {
  connect(options?: McpRequestOptions): Promise<void>
  listTools(options?: McpRequestOptions): Promise<{ readonly tools: readonly McpRemoteTool[] }>
  callTool(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    options?: McpRequestOptions,
  ): Promise<McpCallToolResult>
  close(): Promise<void>
}

export type McpClientFactory = (config: McpServerConfig) => McpClient

const CLIENT_NAME_PREFIX = 'overture-mcp'
const CLIENT_VERSION = '0.1.0'

function requireField(value: string | undefined, serverName: string, field: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `mcp server '${serverName}' is missing required field '${field}' for its transport`,
    )
  }
  return value
}

function buildTransport(
  config: McpServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: requireField(config.command, config.name, 'command'),
      args: config.args !== undefined ? [...config.args] : [],
      // Merge onto the safe inherited environment; server-specific secrets
      // (API keys, etc.) come from `config.env`, never logged anywhere here.
      env: { ...getDefaultEnvironment(), ...config.env },
    })
  }
  return new StreamableHTTPClientTransport(new URL(requireField(config.url, config.name, 'url')), {
    ...(config.headers !== undefined ? { requestInit: { headers: { ...config.headers } } } : {}),
  })
}

/** Builds a real SDK `Client` + transport for `config` and adapts it to `McpClient`. */
export function defaultClientFactory(config: McpServerConfig): McpClient {
  const transport = buildTransport(config)
  const client = new Client(
    { name: `${CLIENT_NAME_PREFIX}-${config.name}`, version: CLIENT_VERSION },
    { capabilities: {} },
  )

  return {
    // The SDK's own transport classes (e.g. `StreamableHTTPClientTransport`'s
    // `sessionId` getter) are typed `string | undefined` for what `Transport`
    // declares as an optional `string` field — a mismatch only surfaced by
    // this repo's `exactOptionalPropertyTypes`, not a real incompatibility.
    connect: (options) => client.connect(transport as Transport, options),
    listTools: async (options) => {
      const result = await client.listTools(undefined, options)
      return {
        tools: result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        })),
      }
    },
    // The SDK's return type is a schema-dependent union; we only ever
    // request the default (non-compatibility) shape, which `McpCallToolResult`
    // covers.
    callTool: (params, options) =>
      client.callTool(params, undefined, options) as Promise<McpCallToolResult>,
    close: () => client.close(),
  }
}

export interface McpToolProviderOptions {
  readonly logger: Logger
  readonly clientFactory?: McpClientFactory
  /** Connection attempts (including the first) before giving up. Default: 3. */
  readonly maxConnectAttempts?: number
  /** Initial delay before the first retry. Default: 250ms. */
  readonly initialBackoffMs?: number
  /** Ceiling for the exponentially-growing retry delay. Default: 5s. */
  readonly maxBackoffMs?: number
}

const DEFAULT_MAX_CONNECT_ATTEMPTS = 3
const DEFAULT_INITIAL_BACKOFF_MS = 250
const DEFAULT_MAX_BACKOFF_MS = 5_000
const BACKOFF_FACTOR = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractText(content: readonly McpContentBlock[] | undefined): string {
  if (content === undefined || content.length === 0) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * `ToolProvider` over one configured MCP server. Connects lazily on first
 * use, retries the initial connection with exponential backoff, and drops
 * its client (reconnecting on the next call) whenever a request fails.
 */
export class McpToolProvider implements ToolProvider {
  readonly id: string
  private readonly config: McpServerConfig
  private readonly logger: Logger
  private readonly clientFactory: McpClientFactory
  private readonly maxConnectAttempts: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private client: McpClient | undefined
  private connecting: Promise<McpClient> | undefined

  constructor(config: McpServerConfig, options: McpToolProviderOptions) {
    if (
      config.transport === 'stdio' &&
      (config.command === undefined || config.command.length === 0)
    ) {
      throw new Error(
        `mcp server '${config.name}' uses transport 'stdio' but has no command configured`,
      )
    }
    if (config.transport === 'http' && (config.url === undefined || config.url.length === 0)) {
      throw new Error(`mcp server '${config.name}' uses transport 'http' but has no url configured`)
    }

    this.config = config
    this.id = `mcp:${config.name}`
    this.logger = options.logger
    this.clientFactory = options.clientFactory ?? defaultClientFactory
    this.maxConnectAttempts = options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  }

  async listTools(): Promise<readonly Tool[]> {
    let client: McpClient
    try {
      client = await this.ensureConnected()
    } catch (error) {
      this.logger.error('mcp server unavailable; exposing no tools', {
        server: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    try {
      const { tools } = await client.listTools()
      return tools.map((tool) => this.toCoreTool(tool))
    } catch (error) {
      this.client = undefined
      this.logger.warn('mcp listTools failed; will reconnect on next use', {
        server: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  /** Closes the underlying client, if one is connected. Safe to call repeatedly. */
  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client === undefined) return
    try {
      await client.close()
    } catch (error) {
      this.logger.warn('error closing mcp client', {
        server: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async ensureConnected(): Promise<McpClient> {
    if (this.client !== undefined) return this.client
    if (this.connecting === undefined) {
      this.connecting = this.connectWithRetry().finally(() => {
        this.connecting = undefined
      })
    }
    const client = await this.connecting
    this.client = client
    return client
  }

  private async connectWithRetry(): Promise<McpClient> {
    let attempt = 0
    let delay = this.initialBackoffMs
    let lastError: unknown

    while (attempt < this.maxConnectAttempts) {
      attempt += 1
      const client = this.clientFactory(this.config)
      try {
        await client.connect()
        return client
      } catch (error) {
        lastError = error
        this.logger.warn('mcp server connect attempt failed', {
          server: this.config.name,
          attempt,
          maxAttempts: this.maxConnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        })
        if (attempt >= this.maxConnectAttempts) break
        await sleep(delay)
        delay = Math.min(delay * BACKOFF_FACTOR, this.maxBackoffMs)
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      `failed to connect to mcp server '${this.config.name}' after ${attempt} attempt(s): ${message}`,
    )
  }

  private toCoreTool(remote: McpRemoteTool): Tool {
    const name = `mcp_${this.config.name}_${remote.name}`
    return {
      descriptor: {
        name,
        description: remote.description ?? '',
        inputSchema: remote.inputSchema,
      },
      requiredPermissions: [PermissionCapability.NetworkConnect],
      policyTarget: () => `mcp:${this.config.name}:${remote.name}`,
      execute: (input, context) => this.executeTool(remote.name, input, context),
    }
  }

  private async executeTool(
    remoteName: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // The policy target for this call; core's `Tool` contract has no target
    // hook today, so this is surfaced via `detail` and logging rather than
    // reaching the policy engine directly (see report to team-lead).
    const target = `mcp:${this.config.name}:${remoteName}`
    const client = await this.ensureConnected()
    const args = isPlainRecord(input) ? input : {}

    let result: McpCallToolResult
    try {
      // Abort signal is honored when the transport supports it; best-effort
      // otherwise (the SDK accepts it unconditionally as a RequestOptions field).
      result = await client.callTool(
        { name: remoteName, arguments: args },
        { signal: context.signal },
      )
    } catch (error) {
      this.client = undefined
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('mcp tool call failed; will reconnect on next use', {
        target,
        error: message,
      })
      throw new Error(`mcp tool call failed (${target}): ${message}`)
    }

    return {
      content: extractText(result.content),
      ...(result.isError === true ? { isError: true } : {}),
      detail: { target },
    }
  }
}

export interface CreateMcpToolProvidersOptions extends McpToolProviderOptions {}

/** Builds an `McpToolProvider` per config, skipping (with a warning) any that fail to construct. */
export function createMcpToolProviders(
  configs: readonly McpServerConfig[],
  options: CreateMcpToolProvidersOptions,
): McpToolProvider[] {
  const providers: McpToolProvider[] = []
  for (const config of configs) {
    try {
      providers.push(new McpToolProvider(config, options))
    } catch (error) {
      options.logger.warn('failed to construct mcp tool provider; skipping', {
        server: config.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return providers
}
