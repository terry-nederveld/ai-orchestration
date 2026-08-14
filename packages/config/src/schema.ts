/**
 * Configuration schema. Secrets are referenced by name (resolved through the
 * SecretProvider) — raw secret values never live in configuration files.
 */

import { z } from 'zod'

const secretName = z.string().min(1).describe('Name of a secret in the secret store')

export const providerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    apiKeySecret: secretName.optional(),
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

export const routeProfileSchema = z
  .object({
    executor: z.string().min(1),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    requires: z.array(z.string()).optional(),
  })
  .strict()

export const budgetLimitsSchema = z
  .object({
    maxConcurrentAgents: z.number().int().positive().optional(),
    maxSubagentsPerRun: z.number().int().nonnegative().optional(),
    maxIterations: z.number().int().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxEstimatedCostUsd: z.number().positive().optional(),
    maxSubscriptionRequests: z.number().int().positive().optional(),
    providerQuotas: z.record(z.string(), z.number()).optional(),
  })
  .strict()

export const permissionRuleSchema = z
  .object({
    id: z.string().min(1),
    capability: z.string().min(1),
    target: z.string().optional(),
    effect: z.enum(['allow', 'deny', 'ask', 'sandbox-only']),
  })
  .strict()

export const workSourceSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    container: z.string().optional(),
    tokenSecret: secretName.optional(),
    baseUrl: z.string().url().optional(),
    query: z.record(z.string(), z.unknown()).default({}),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

export const mcpServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    scope: z.enum(['global', 'project', 'workflow']).default('global'),
  })
  .strict()
  .refine((server) => (server.transport === 'stdio' ? !!server.command : !!server.url), {
    message: 'stdio servers need command; http servers need url',
  })

export const agentRoleSchema = z
  .object({
    systemPrompt: z.string().optional(),
    route: z.string().optional(),
    toolNames: z.array(z.string()).optional(),
    maxTurns: z.number().int().positive().optional(),
  })
  .strict()

export const overtureConfigSchema = z
  .object({
    providers: z.record(z.string(), providerConfigSchema).default({}),
    routing: z
      .object({
        defaultProfile: z.string().default('default'),
        profiles: z.record(z.string(), routeProfileSchema).default({}),
      })
      .strict()
      .default({ defaultProfile: 'default', profiles: {} }),
    budgets: z.record(z.string(), budgetLimitsSchema).default({}),
    permissions: z
      .object({
        defaultEffect: z.enum(['allow', 'deny', 'ask', 'sandbox-only']).default('deny'),
        rules: z.array(permissionRuleSchema).default([]),
        /**
         * Named rule preset appended after configured rules. 'workspace-coding'
         * allows the filesystem/process/git/issue capabilities a coding agent
         * needs; 'none' leaves only configured rules and defaultEffect.
         * Defaults to 'workspace-coding' ONLY when no rules and no explicit
         * defaultEffect are configured; any explicit permissions config
         * disables the implicit preset.
         */
        preset: z.enum(['workspace-coding', 'none']).optional(),
      })
      .strict()
      .default({ defaultEffect: 'deny', rules: [] }),
    workspaces: z
      .object({
        root: z.string().optional(),
        reposRoot: z.string().optional(),
        defaultStrategy: z.string().default('git-worktree'),
        retention: z.enum(['always', 'on-failure', 'never']).default('on-failure'),
      })
      .strict()
      .default({ defaultStrategy: 'git-worktree', retention: 'on-failure' }),
    work: z.array(workSourceSchema).default([]),
    mcp: z
      .object({ servers: z.array(mcpServerSchema).default([]) })
      .strict()
      .default({ servers: [] }),
    extensions: z
      .object({ paths: z.array(z.string()).default([]) })
      .strict()
      .default({ paths: [] }),
    skills: z
      .object({ paths: z.array(z.string()).default([]) })
      .strict()
      .default({ paths: [] }),
    agents: z.record(z.string(), agentRoleSchema).default({}),
    orchestrator: z
      .object({
        maxConcurrentRuns: z.number().int().positive().default(2),
        pollIntervalMs: z.number().int().positive().default(60_000),
        claimant: z.string().default('overture'),
        branchPrefix: z.string().default('overture'),
        defaultBudget: z.string().default('default'),
        workflowsDir: z.string().optional(),
      })
      .strict()
      .default({
        maxConcurrentRuns: 2,
        pollIntervalMs: 60_000,
        claimant: 'overture',
        branchPrefix: 'overture',
        defaultBudget: 'default',
      }),
    daemon: z
      .object({
        port: z.number().int().min(0).max(65_535).default(43_117),
        host: z.string().default('127.0.0.1'),
      })
      .strict()
      .default({ port: 43_117, host: '127.0.0.1' }),
  })
  .strict()

export type OvertureConfig = z.infer<typeof overtureConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type WorkSourceConfig = z.infer<typeof workSourceSchema>
export type McpServerConfig = z.infer<typeof mcpServerSchema>

export const configJsonSchema = z.toJSONSchema(overtureConfigSchema, { io: 'input' })
