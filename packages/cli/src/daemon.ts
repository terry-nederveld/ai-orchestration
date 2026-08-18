/**
 * Daemon assembly: builds the full Overture service from configuration and
 * runs it in the foreground with the loopback control plane. This is the
 * composition root — the only place concrete providers meet the kernel.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, type OvertureConfig } from '@overture/config'
import {
  type AgentProvider,
  type Clock,
  DefinitionKind,
  type IdGenerator,
  InMemoryEventBus,
  type Logger,
  type ModelProvider,
  type PermissionRule,
  type SecretProvider,
  systemClock,
  type WorkflowDefinition,
  type WorkflowProvider,
  type WorkProvider,
} from '@overture/core'
import {
  builtinActionFactory,
  DefaultCommandRunner,
  DefaultSpecBuilder,
  GraphRunCoordinator,
  GraphScheduler,
  ProfileAgentRouter,
  profileExperimentStepperFactory,
  RunCoordinator,
  Scheduler,
  WorkflowActionRegistry,
} from '@overture/orchestrator'
import { RuleBasedPolicyEngine, workspaceCodingRules } from '@overture/policy'
import { resolveSecretProvider, SecretRedactor } from '@overture/secrets'
import {
  ApprovalBroker,
  clearDaemonInfo,
  defaultStateDir,
  OvertureService,
  startControlPlane,
  writeDaemonInfo,
} from '@overture/server'

const VERSION = '0.1.0'

export interface AssembledDaemon {
  readonly service: OvertureService
  readonly config: OvertureConfig
  readonly secrets: SecretProvider
  /**
   * Durable graph runtime periodic work: recover interrupted runs once,
   * then each poll interval fire due wait timers and schedules and
   * dispatch enabled backlog lanes.
   */
  readonly graphTick: () => Promise<void>
  readonly graphRecover: () => Promise<void>
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly redactor: SecretRedactor,
    private readonly fields: Record<string, unknown> = {},
  ) {}

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    const merged = { ...this.fields, ...fields }
    const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : ''
    const line = `[${new Date().toISOString()}] ${level} ${message}${suffix}`
    process.stderr.write(`${this.redactor.redact(line)}\n`)
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    if (process.env.OVERTURE_DEBUG) this.write('DEBUG', message, fields)
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('INFO', message, fields)
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('WARN', message, fields)
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('ERROR', message, fields)
  }
  child(fields: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.redactor, { ...this.fields, ...fields })
  }
}

class RandomIds implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`
  }
}

class CompositeWorkflowProvider implements WorkflowProvider {
  readonly id = 'composite'
  constructor(private readonly providers: readonly WorkflowProvider[]) {}

  async list(): Promise<readonly WorkflowDefinition[]> {
    const byName = new Map<string, WorkflowDefinition>()
    // Later providers override earlier ones (builtin < user dir < project).
    for (const provider of this.providers) {
      for (const definition of await provider.list()) {
        byName.set(definition.name, definition)
      }
    }
    return [...byName.values()]
  }

  async get(name: string): Promise<WorkflowDefinition | undefined> {
    const all = await this.list()
    return all.find((definition) => definition.name === name)
  }
}

/**
 * Build the daemon from configuration. Provider construction is delegated to
 * registries so new provider types plug in without touching this function's
 * control flow.
 */
export async function assembleDaemon(options: {
  readonly stateDir: string
  readonly projectDir?: string
  readonly clock?: Clock
}): Promise<AssembledDaemon> {
  const clock = options.clock ?? systemClock
  const ids = new RandomIds()
  const redactor = new SecretRedactor()
  const logger = new ConsoleLogger(redactor)

  const { config, layers } = await loadConfig({
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  })

  await mkdir(options.stateDir, { recursive: true })
  const secrets = await resolveSecretProvider({ fallbackDirectory: options.stateDir })
  const resolveSecret = async (name: string | undefined): Promise<string | undefined> => {
    if (!name) return undefined
    const value = await secrets.get(name)
    redactor.track(value)
    return value
  }

  const { SqlitePersistenceProvider } = await import('@overture/persistence')
  const persistence = new SqlitePersistenceProvider(join(options.stateDir, 'overture.db'))
  await persistence.migrate()

  const events = new InMemoryEventBus(logger)
  const approvals = new ApprovalBroker(ids, clock)

  // ----- policy ----------------------------------------------------------
  const configuredRules: PermissionRule[] = config.permissions.rules.map((rule) => ({
    id: rule.id,
    capability: rule.capability as PermissionRule['capability'],
    effect: rule.effect,
    ...(rule.target !== undefined ? { target: rule.target } : {}),
  }))
  // The workspace-coding preset applies only when explicitly requested, or
  // implicitly when the operator configured no permissions at all. Any
  // explicit permissions configuration disables the implicit preset so a
  // configured defaultEffect actually holds (security review finding
  // POLICY-BYPASS-DEFAULT).
  const operatorConfiguredPermissions = layers.some((layer) => 'permissions' in layer.values)
  const presetRequested =
    config.permissions.preset === 'workspace-coding' ||
    (config.permissions.preset === undefined && !operatorConfiguredPermissions)
  const policy = new RuleBasedPolicyEngine({
    rules: presetRequested ? [...configuredRules, ...workspaceCodingRules()] : configuredRules,
    defaultEffect: config.permissions.defaultEffect,
  })
  if (presetRequested && operatorConfiguredPermissions) {
    logger.info('workspace-coding permission preset enabled by explicit configuration')
  }

  // ----- model providers -------------------------------------------------
  const { AnthropicModelProvider } = await import('@overture/model-anthropic')
  const {
    createOllamaProvider,
    createOpenAICompatibleProvider,
    createOpenAIProvider,
    createOpenRouterProvider,
  } = await import('@overture/model-openai')

  const modelProviders: ModelProvider[] = []
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue
    const apiKey = () => resolveSecret(providerConfig.apiKeySecret ?? `provider/${id}/api-key`)
    if (id === 'anthropic') {
      modelProviders.push(
        new AnthropicModelProvider({
          apiKey,
          ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
        }),
      )
    } else if (id === 'openai') {
      modelProviders.push(
        createOpenAIProvider({
          apiKey,
          ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
        }),
      )
    } else if (id === 'openrouter') {
      modelProviders.push(createOpenRouterProvider({ apiKey }))
    } else if (id === 'ollama') {
      modelProviders.push(
        providerConfig.baseUrl
          ? createOpenAICompatibleProvider({
              id: 'ollama',
              baseUrl: providerConfig.baseUrl,
              requiresAuth: false,
              apiKey: async () => undefined,
            })
          : createOllamaProvider({}),
      )
    } else if (providerConfig.baseUrl) {
      modelProviders.push(
        createOpenAICompatibleProvider({ id, baseUrl: providerConfig.baseUrl, apiKey }),
      )
    } else {
      logger.warn('unknown model provider in config; skipping', { provider: id })
    }
  }

  // ----- agent executors -------------------------------------------------
  const { NativeAgentRuntime, DefaultToolRegistry } = await import('@overture/runtime')
  const { createCodingToolProvider } = await import('@overture/tools')

  const routingProfiles: Record<string, import('@overture/orchestrator').RouteProfile> = {}
  for (const [name, profile] of Object.entries(config.routing.profiles)) {
    routingProfiles[name] = {
      executor: profile.executor,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
    }
  }

  const agentProviders: AgentProvider[] = []
  const router = new ProfileAgentRouter({
    profiles: routingProfiles,
    defaultProfile: config.routing.defaultProfile,
  })

  const toolRegistry = new DefaultToolRegistry()
  toolRegistry.register(createCodingToolProvider())

  // ----- extensions, MCP, hooks, skills ----------------------------------
  const {
    DefaultHookRegistry,
    DirectoryExtensionProvider,
    ExtensionHost,
    createMcpToolProviders,
    loadSkillsFromDirectories,
    renderSkillsPrompt,
  } = await import('@overture/extensions')

  const hooks = new DefaultHookRegistry({ logger: logger.child({ component: 'hooks' }) })
  const extensionActions: import('@overture/core').WorkflowAction[] = []
  for (const path of config.extensions.paths) {
    const host = new ExtensionHost({
      provider: new DirectoryExtensionProvider({ id: `dir:${path}`, rootDir: path, logger }),
      hookRegistry: hooks,
      toolRegistry,
      actionSink: (contributed) => extensionActions.push(...contributed),
      logger,
    })
    const summary = await host.loadAll()
    if (summary.loaded.length > 0) {
      logger.info('extensions loaded', { path, loaded: summary.loaded })
    }
    for (const failure of summary.failed) {
      logger.warn('extension failed to load', { id: failure.id, error: failure.error })
    }
  }

  const mcpConfigs = config.mcp.servers.map((server) => ({
    name: server.name,
    transport: server.transport,
    args: server.args,
    env: server.env,
    headers: server.headers,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
  }))
  for (const mcpProvider of createMcpToolProviders(mcpConfigs, { logger })) {
    toolRegistry.register(mcpProvider)
  }

  const skills = await loadSkillsFromDirectories(config.skills.paths)
  const skillsPrompt = skills.length > 0 ? renderSkillsPrompt(skills) : undefined
  if (skills.length > 0) {
    logger.info('skills loaded', { count: skills.length })
  }

  for (const modelProvider of modelProviders) {
    const runtime = new NativeAgentRuntime({
      model: modelProvider,
      defaultModel: config.providers[modelProvider.info.id]?.defaultModel ?? '',
      tools: toolRegistry,
      policy,
      approvals,
      hooks,
      sessions: {
        save: (snapshot) => persistence.sessions.save(redactor.redactObject(snapshot)),
        get: (id) => persistence.sessions.get(id),
        listForRun: (runId) => persistence.sessions.listForRun(runId),
      },
      clock,
      logger: logger.child({ runtime: `native-${modelProvider.info.id}` }),
      resolveSecret,
    })
    router.register({
      id: `native-${modelProvider.info.id}`,
      start: (request) => runtime.start(request),
      capabilities: () => modelProvider.capabilities(),
    })
  }

  const { ClaudeCodeAgentProvider } = await import('@overture/agent-claude-code')
  const { CodexAgentProvider } = await import('@overture/agent-codex')
  const { CopilotAgentProvider } = await import('@overture/agent-copilot')

  const claudeCode = new ClaudeCodeAgentProvider({ auth: { kind: 'cli-session' } })
  const codex = new CodexAgentProvider({ auth: { kind: 'cli-session' } })
  const copilot = new CopilotAgentProvider({ auth: { kind: 'cli-session' } })
  for (const provider of [claudeCode, codex, copilot] as AgentProvider[]) {
    agentProviders.push(provider)
    router.register({
      id: provider.info.id,
      start: (request) => provider.start(request),
      capabilities: () => provider.capabilities(),
    })
  }

  // Fallback default profile when configuration provides none.
  if (!routingProfiles[config.routing.defaultProfile]) {
    const detected = await claudeCode.detect().catch(() => undefined)
    if (detected?.available) {
      routingProfiles[config.routing.defaultProfile] = { executor: claudeCode.info.id }
    } else if (modelProviders[0]) {
      const fallbackModel = config.providers[modelProviders[0].info.id]?.defaultModel
      routingProfiles[config.routing.defaultProfile] = {
        executor: `native-${modelProviders[0].info.id}`,
        ...(fallbackModel !== undefined ? { model: fallbackModel } : {}),
      }
    } else {
      logger.warn(
        'no default routing profile and no usable executors; agent steps will fail until configured',
      )
    }
  }

  // Configured skills are appended to every routing profile's system prompt.
  if (skillsPrompt) {
    for (const [name, profile] of Object.entries(routingProfiles)) {
      routingProfiles[name] = {
        ...profile,
        systemPrompt: profile.systemPrompt
          ? `${profile.systemPrompt}\n\n${skillsPrompt}`
          : skillsPrompt,
      }
    }
  }

  // ----- work providers --------------------------------------------------
  const workProviders = new Map<string, WorkProvider>()
  for (const source of config.work) {
    const token = () => resolveSecret(source.tokenSecret ?? `work/${source.id}/token`)
    if (source.type === 'github') {
      const { GitHubIssuesWorkProvider } = await import('@overture/work-github')
      workProviders.set(
        source.id,
        new GitHubIssuesWorkProvider({ token, repo: source.container ?? '' }),
      )
    } else if (source.type === 'jira-cloud') {
      const { JiraCloudWorkProvider } = await import('@overture/work-jira-cloud')
      workProviders.set(
        source.id,
        new JiraCloudWorkProvider({
          site: source.baseUrl ?? '',
          auth: async () => {
            const value = await token()
            const email = (source.options.email as string | undefined) ?? ''
            return value ? { email, apiToken: value } : undefined
          },
          ...(source.container ? { projectKey: source.container } : {}),
        }),
      )
    } else if (source.type === 'jira-datacenter') {
      const { JiraDataCenterWorkProvider } = await import('@overture/work-jira-datacenter')
      workProviders.set(
        source.id,
        new JiraDataCenterWorkProvider({
          baseUrl: source.baseUrl ?? '',
          auth: async () => {
            const value = await token()
            return value ? { pat: value } : undefined
          },
          ...(source.container ? { projectKey: source.container } : {}),
        }),
      )
    } else if (source.type === 'linear') {
      const { LinearWorkProvider } = await import('@overture/work-linear')
      workProviders.set(
        source.id,
        new LinearWorkProvider({
          apiKey: token,
          ...(source.container ? { teamKey: source.container } : {}),
        }),
      )
    } else {
      logger.warn('unknown work source type in config; skipping', {
        source: source.id,
        type: source.type,
      })
    }
  }

  // ----- scm + workspaces ------------------------------------------------
  const { GitHubSourceControlProvider, GitSourceControlProvider, GitWorktreeManager } =
    await import('@overture/scm-git')
  const {
    GitCloneWorkspaceProvider,
    GitWorktreeWorkspaceProvider,
    LocalDirectoryWorkspaceProvider,
    TempDirectoryWorkspaceProvider,
    WorkspaceProviderRegistry,
  } = await import('@overture/workspaces')

  const scm = new GitHubSourceControlProvider()
  const gitScm = new GitSourceControlProvider()
  const worktrees = new GitWorktreeManager()
  const reposRoot = config.workspaces.reposRoot ?? join(options.stateDir, 'repos')
  const workspacesRoot = config.workspaces.root ?? join(options.stateDir, 'workspaces')
  await mkdir(reposRoot, { recursive: true })
  await mkdir(workspacesRoot, { recursive: true })

  const workspaceRegistry = new WorkspaceProviderRegistry()
  workspaceRegistry.register(
    new GitWorktreeWorkspaceProvider({ reposRoot, workspacesRoot, scm: gitScm, worktrees }),
  )
  workspaceRegistry.register(new GitCloneWorkspaceProvider({ workspacesRoot, scm: gitScm }))
  workspaceRegistry.register(new LocalDirectoryWorkspaceProvider())
  workspaceRegistry.register(new TempDirectoryWorkspaceProvider())

  // ----- workflows --------------------------------------------------------
  const { DirectoryWorkflowProvider, createBuiltinWorkflowProvider } = await import(
    '@overture/workflow'
  )
  const workflowProviders: WorkflowProvider[] = [createBuiltinWorkflowProvider()]
  if (config.orchestrator.workflowsDir) {
    workflowProviders.push(new DirectoryWorkflowProvider(config.orchestrator.workflowsDir))
  }
  if (options.projectDir) {
    workflowProviders.push(new DirectoryWorkflowProvider(join(options.projectDir, '.overture')))
  }
  const workflows = new CompositeWorkflowProvider(workflowProviders)

  // ----- kernel -----------------------------------------------------------
  const actions = new WorkflowActionRegistry()
  actions.register(builtinActionFactory)
  if (extensionActions.length > 0) {
    actions.register(() => extensionActions)
  }

  // Items carry their adapter's provider id; resolve claims/transitions by it.
  const byAdapterId = new Map<string, WorkProvider>()
  for (const provider of workProviders.values()) {
    if (byAdapterId.has(provider.info.id)) {
      logger.warn(
        'multiple work sources share one adapter id; claims resolve to the first instance',
        { adapter: provider.info.id },
      )
      continue
    }
    byAdapterId.set(provider.info.id, provider)
  }

  const coordinator = new RunCoordinator({
    work: { resolve: (providerId) => byAdapterId.get(providerId) },
    workspaces: {
      resolve: (strategy) =>
        workspaceRegistry.has(strategy as never)
          ? workspaceRegistry.resolve(strategy as never)
          : undefined,
    },
    agents: router,
    commands: new DefaultCommandRunner(),
    actions,
    approvals,
    persistence,
    events,
    clock,
    ids,
    logger,
    scm,
    claimant: config.orchestrator.claimant,
    branchPrefix: config.orchestrator.branchPrefix,
  })

  const scheduler = new Scheduler({
    sources: [...workProviders.values()].map((provider) => ({ provider })),
    workflows,
    coordinator,
    persistence,
    events,
    clock,
    ids,
    logger,
    pollIntervalMs: config.orchestrator.pollIntervalMs,
    maxConcurrentRuns: config.orchestrator.maxConcurrentRuns,
  })

  // ----- durable graph runtime (phase 2) ---------------------------------
  const { ConventionInstructionProvider } = await import('@overture/resolution')
  const { GitBranchCheckpointStrategy, WorkItemSectionCheckpointStrategy } = await import(
    '@overture/checkpoints'
  )
  const { installTemplates } = await import('@overture/templates')

  // Idempotent (content-addressed); first install starts DRAFT, then is
  // enabled once. An operator's later disable is never overridden.
  const installed = await installTemplates(persistence.definitions)
  for (const definition of installed) {
    const lifecycle = await persistence.definitions.getLifecycle(definition.kind, definition.name)
    if (lifecycle === 'draft') {
      await persistence.definitions.setLifecycle(definition.kind, definition.name, 'enabled')
    }
  }

  const specBuilder = new DefaultSpecBuilder({
    clock,
    mapping: {
      name: 'config',
      rules: config.mapping.rules.map((rule) => ({
        id: rule.id,
        priority: rule.priority,
        when: rule.when as import('@overture/core').MappingPredicate,
        repositories: rule.repositories.map((entry) => ({
          repository: {
            locator: entry.locator,
            ...(entry.defaultBranch !== undefined ? { defaultBranch: entry.defaultBranch } : {}),
            ...(entry.scmProviderId !== undefined ? { scmProviderId: entry.scmProviderId } : {}),
          },
          role: entry.role,
        })),
        ...(rule.onConflict !== undefined ? { onConflict: rule.onConflict } : {}),
      })),
    },
    instructions: [new ConventionInstructionProvider()],
  })

  const gitCheckpoints = new GitBranchCheckpointStrategy({
    scm: gitScm,
    workspaces: { reposRoot, workspacesRoot, worktrees },
    resolveRepository: async (runId) => {
      const spec = await persistence.specs.latest(runId)
      const primary =
        spec?.repositories.find((entry) => entry.role === 'primary') ?? spec?.repositories[0]
      return primary ? { locator: primary.repository.locator } : undefined
    },
    clock,
  })
  const sectionCheckpoints = new WorkItemSectionCheckpointStrategy({
    resolveItem: async (workItemId) => {
      const separator = workItemId.indexOf(':')
      if (separator === -1) return undefined
      const provider = byAdapterId.get(workItemId.slice(0, separator))
      if (!provider) return undefined
      const item = await provider.get(workItemId.slice(separator + 1)).catch(() => undefined)
      return item ? { provider, item } : undefined
    },
    clock,
  })

  const graphCoordinator = new GraphRunCoordinator({
    persistence,
    work: { resolve: (providerId) => byAdapterId.get(providerId) },
    workspaces: {
      resolve: (strategy) =>
        workspaceRegistry.has(strategy as never)
          ? workspaceRegistry.resolve(strategy as never)
          : undefined,
    },
    executors: { get: (id) => router.getExecutor(id) },
    commands: new DefaultCommandRunner(),
    actions,
    specBuilder,
    scm,
    checkpoints: {
      // Coding runs (a workspace exists) checkpoint to the run branch;
      // everything else checkpoints into the work item's managed section.
      select: (_run, workspace) => (workspace ? gitCheckpoints : sectionCheckpoints),
    },
    experiments: profileExperimentStepperFactory({
      experiments: persistence.experiments,
      judgments: persistence.judgments,
    }),
    events,
    clock,
    ids,
    logger: logger.child({ component: 'graph' }),
    claimant: config.orchestrator.claimant,
    branchPrefix: config.orchestrator.branchPrefix,
  })

  const graphScheduler = new GraphScheduler({
    persistence,
    starter: graphCoordinator,
    events,
    clock,
    ids,
    logger: logger.child({ component: 'graph-scheduler' }),
  })

  // Routing-selection waits live under a synthetic `routing:` run, so they
  // resolve through the scheduler; every other wait resumes its run through
  // the graph coordinator.
  const graphWaits = {
    satisfy: async (
      waitId: string,
      response: {
        readonly responder: string
        readonly channel: 'app' | 'work_item'
        readonly value?: unknown
        readonly event?: Readonly<Record<string, unknown>>
      },
    ): Promise<{ readonly accepted: boolean; readonly reason?: string }> => {
      const condition = await persistence.waits.get(waitId)
      if (condition?.parameters['reason'] === 'WORKFLOW_SELECTION_REQUIRED') {
        const outcome = await graphScheduler.onSelection(waitId, {
          workflow: String(response.value ?? ''),
          responder: response.responder,
        })
        return {
          accepted: outcome.accepted,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        }
      }
      return graphCoordinator.satisfy(waitId, response)
    },
  }

  const dispatchLanes = async (): Promise<void> => {
    const statuses = await persistence.definitions.list(DefinitionKind.Lane)
    for (const status of statuses) {
      if (status.lifecycle !== 'enabled') continue
      const version = await persistence.definitions.get(DefinitionKind.Lane, status.name)
      const lane = version?.document as unknown as import('@overture/core').LaneDefinition
      if (!lane?.enabled) continue
      const provider = workProviders.get(lane.source)
      if (!provider) {
        logger.warn('lane references unknown work source', {
          lane: lane.name,
          source: lane.source,
        })
        continue
      }
      // Provider discovery order is the backlog's native rank — preserved.
      const candidates = await provider
        .discover((lane.query ?? {}) as import('@overture/core').WorkQuery)
        .catch((error) => {
          logger.warn('lane discovery failed', {
            lane: lane.name,
            error: error instanceof Error ? error.message : String(error),
          })
          return [] as const
        })
      if (candidates.length > 0) await graphScheduler.dispatchLane(lane, candidates)
    }
  }

  const service = new OvertureService({
    version: VERSION,
    redactEvent: (event) => redactor.redactObject(event),
    redactPayload: (payload) => redactor.redactObject(payload),
    persistence,
    events,
    scheduler,
    coordinator,
    graphCoordinator: graphWaits,
    evaluateExecutors: { has: (id) => router.getExecutor(id) !== undefined },
    workflows,
    workProviders,
    modelProviders,
    agentProviders,
    approvals,
    clock,
    ids,
    logger,
  })

  return {
    service,
    config,
    secrets,
    graphRecover: async () => graphCoordinator.recover(),
    graphTick: async () => {
      await graphCoordinator.fireDueTimers(clock.now())
      await graphScheduler.fireDueSchedules(clock.now())
      await dispatchLanes()
    },
  }
}

export async function runDaemon(args: readonly string[], stateDir: string): Promise<number> {
  const projectDir = process.cwd()
  const { service, config, graphRecover, graphTick } = await assembleDaemon({
    stateDir,
    projectDir,
  })

  const portFlagIndex = args.indexOf('--port')
  const port =
    portFlagIndex !== -1 && args[portFlagIndex + 1]
      ? Number(args[portFlagIndex + 1])
      : config.daemon.port

  await service.start()
  await graphRecover().catch((error) => {
    process.stderr.write(`graph recovery failed: ${String(error)}\n`)
  })
  const graphInterval = setInterval(() => {
    void graphTick().catch((error) => {
      process.stderr.write(`graph tick failed: ${String(error)}\n`)
    })
  }, config.orchestrator.pollIntervalMs)
  const handle = await startControlPlane(service, { host: config.daemon.host, port })
  await writeDaemonInfo(stateDir, {
    host: handle.host,
    port: handle.port,
    token: handle.token,
    pid: process.pid,
  })
  process.stderr.write(`overture daemon listening on ${handle.host}:${handle.port}\n`)

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      process.stderr.write('shutting down…\n')
      clearInterval(graphInterval)
      void (async () => {
        await service.cancelAllActive().catch(() => {})
        await handle.close().catch(() => {})
        await service.stop().catch(() => {})
        await clearDaemonInfo(stateDir).catch(() => {})
        resolveShutdown()
      })()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  return 0
}

export { defaultStateDir }
