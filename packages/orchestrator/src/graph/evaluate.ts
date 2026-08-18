/**
 * Side-effect-free Evaluate (mission §27): given a work item and a workflow
 * definition, produce a complete dry-run report — what would run, which
 * repositories, instructions, and context would be assembled, how gates
 * would evaluate, the determinable execution path, and every side effect
 * that WOULD occur — without causing ANY of them. No runs are created, no
 * waits opened, no workspace prepared, nothing persisted, nothing external
 * mutated.
 *
 * Zero side effects by construction: evaluateWorkflow accepts only the
 * narrow read-only port interfaces defined in this file, so a caller
 * physically cannot hand it a write path. Executor availability is a
 * boolean probe (never a start function), work items are read but never
 * commented on or transitioned, and the graph walk predicts node outcomes
 * from caller-supplied hypothetical outputs instead of executing anything.
 * Determinism: no clock, no randomness, no network — the report depends
 * only on the inputs and what the read ports return.
 */

import type {
  ContextFragment,
  ContextResolver,
  DefinitionLifecycle,
  DefinitionStatus,
  DefinitionStore,
  DefinitionVersion,
  Gate,
  GateSet,
  GraphIssue,
  GraphNode,
  GraphTransition,
  InstructionProvider,
  LifecycleEffect,
  MappingRuleSet,
  ResolvedRepository,
  ResolvedSnapshot,
  WorkflowGraph,
  WorkItem,
} from '@overture/core'
import {
  asId,
  assembleContext,
  composeGateSets,
  DefinitionKind,
  defaultAttachmentPolicy,
  defaultTraversalPolicy,
  evaluatePredicate,
  findInSnapshot,
  mergeInstructions,
  OrchestratorError,
  resolveRepositories,
  validateGraph,
} from '@overture/core'
import { evaluateScopeExpression, evaluateScopeValue, type Scope } from '@overture/workflow'
import { resolveProfileFromSnapshot } from './node-executors.js'
import { SnapshotResolver } from './snapshot.js'

// ---------------------------------------------------------------------------
// Read-only ports. These are deliberately the narrowest surfaces Evaluate
// needs; none of them can express a mutation.
// ---------------------------------------------------------------------------

/** Read side of a DefinitionStore; no save/setLifecycle/saveSnapshot. */
export interface EvaluateDefinitionReader {
  get(kind: DefinitionKind, name: string, version?: number): Promise<DefinitionVersion | undefined>
  list(kind: DefinitionKind): Promise<readonly DefinitionStatus[]>
  getLifecycle(kind: DefinitionKind, name: string): Promise<DefinitionLifecycle>
}

/** Read access to the configured work-item → repository mapping rules. */
export interface EvaluateMappingReader {
  getRuleSet(): Promise<MappingRuleSet | undefined>
}

/** Availability probe for executor ids; never exposes a start function. */
export interface EvaluateExecutorReader {
  has(executorId: string): boolean
}

/** Read-only slice of a WorkProvider: fetch items, nothing else. */
export interface EvaluateWorkReader {
  get(externalId: string, container?: string): Promise<WorkItem>
}

export interface EvaluatePorts {
  readonly definitions: EvaluateDefinitionReader
  readonly executors: EvaluateExecutorReader
  readonly mapping?: EvaluateMappingReader
  /** Instruction discovery (read-only filesystem scans). */
  readonly instructionProviders?: readonly InstructionProvider[]
  /** Local checkout paths to scan for instruction files, when available. */
  readonly repositoryPaths?: readonly string[]
  /** Context resolvers to preview; they read the work provider only. */
  readonly contextResolvers?: readonly ContextResolver[]
  /** Used to fetch the parent item for mapping-rule predicates. */
  readonly work?: EvaluateWorkReader
}

export interface EvaluateInput {
  readonly item: WorkItem
  readonly workflowName: string
  readonly version?: number
  readonly variables?: Readonly<Record<string, unknown>>
  /** Assumed node outputs; a node listed here is treated as succeeded. */
  readonly hypotheticalOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

// ---------------------------------------------------------------------------
// Report shape.
// ---------------------------------------------------------------------------

export type GatePreviewOutcome = 'pass' | 'fail' | 'indeterminate'

export interface GatePreview {
  readonly gateId: string
  readonly kind: Gate['kind']
  readonly required: boolean
  readonly outcome: GatePreviewOutcome
  readonly reason: string
}

export interface GateNodePreview {
  readonly nodeId: string
  readonly gateSetName: string
  readonly gateSetVersion: number
  readonly gates: readonly GatePreview[]
}

export interface ProfilePreview {
  readonly nodeId: string
  readonly profileName: string
  readonly primaryExecutor?: string
  readonly primaryAvailable?: boolean
  readonly fallbackChain: ReadonlyArray<{
    readonly executor: string
    readonly available: boolean
  }>
  /** True when the primary or any fallback executor is available. */
  readonly satisfiable: boolean
  readonly error?: string
}

export type ExpectedSideEffectKind =
  | 'projection'
  | 'agent-session'
  | 'command'
  | 'action'
  | 'child-run'
  | 'checkpoint'
  | 'work-item-comment'

export interface ExpectedSideEffect {
  readonly nodeId: string
  readonly kind: ExpectedSideEffectKind
  readonly description: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface EvaluationBlocker {
  readonly kind:
    | 'workflow-not-enabled'
    | 'validation'
    | 'snapshot-resolution'
    | 'missing-profile'
    | 'missing-executor'
    | 'no-repository'
  readonly message: string
}

export interface EvaluationReport {
  readonly workflow: {
    readonly name: string
    readonly version: number
    readonly lifecycle: DefinitionLifecycle
    readonly validationIssues: readonly GraphIssue[]
  }
  readonly matching: {
    readonly selection: 'explicit'
    readonly rationale: string
  }
  readonly repositories: {
    readonly resolved: readonly ResolvedRepository[]
    readonly rulesEvaluated: ReadonlyArray<{
      readonly ruleId: string
      readonly priority: number
      readonly matched: boolean
      readonly onConflict: 'replace' | 'merge'
    }>
  }
  readonly instructions: ReadonlyArray<{
    readonly providerId: string
    readonly source: string
    readonly scope: 'global' | 'repository' | 'directory'
    readonly path: string
    readonly precedence: number
  }>
  readonly contextPreview: {
    readonly fragments: ReadonlyArray<{
      readonly resolverId: string
      readonly kind: string
      readonly title: string
      readonly priority: number
      readonly provenance: string
      readonly chars: number
    }>
    readonly excluded: ReadonlyArray<{ readonly title: string; readonly reason: string }>
    readonly totalChars: number
  }
  readonly gates: readonly GateNodePreview[]
  readonly path: {
    readonly nodes: readonly string[]
    /**
     * 'terminal:<nodeId>' when a terminal was reached,
     * 'indeterminate:<nodeId>' where the walk could no longer be decided,
     * 'failed:<nodeId>' / 'loop-bound:<transitionId>' / 'stalled' /
     * 'invalid-graph' otherwise.
     */
    readonly stopReason: string
  }
  readonly profiles: readonly ProfilePreview[]
  readonly expectedSideEffects: readonly ExpectedSideEffect[]
  readonly blockers: readonly EvaluationBlocker[]
}

const CONTEXT_PREVIEW_MAX_CHARS = 24_000
const WALK_SETTLEMENT_BACKSTOP = 500

// ---------------------------------------------------------------------------

export async function evaluateWorkflow(
  input: EvaluateInput,
  ports: EvaluatePorts,
): Promise<EvaluationReport> {
  const blockers: EvaluationBlocker[] = []
  const { item } = input

  const root = await ports.definitions.get(
    DefinitionKind.Workflow,
    input.workflowName,
    input.version,
  )
  if (!root) {
    throw new OrchestratorError(
      `workflow '${input.workflowName}'${input.version !== undefined ? `@${input.version}` : ''} not found`,
      'invalid-input',
    )
  }
  const lifecycle = await ports.definitions.getLifecycle(
    DefinitionKind.Workflow,
    input.workflowName,
  )
  if (lifecycle !== 'enabled') {
    blockers.push({
      kind: 'workflow-not-enabled',
      message: `workflow '${root.name}' is ${lifecycle}; only enabled workflows start new runs`,
    })
  }

  const graph = root.document as unknown as WorkflowGraph
  const validationIssues = validateGraph(graph)
  if (validationIssues.length > 0) {
    blockers.push({
      kind: 'validation',
      message: `workflow '${root.name}'@${root.version} has ${validationIssues.length} validation issue(s)`,
    })
  }

  const snapshot = await resolveSnapshotReadOnly(
    ports.definitions,
    root,
    validationIssues,
    blockers,
  )

  const variables: Record<string, unknown> = {
    ...graph.variables,
    ...input.variables,
    work_title: item.title,
    work_id: item.externalId,
  }
  const hypotheticals = input.hypotheticalOutputs ?? {}

  const repositories = await resolveRepositoriesSection(item, ports)
  const isCodingWorkflow =
    graph.workspace?.strategy !== undefined && graph.workspace.strategy !== 'none'
  if (isCodingWorkflow && repositories.resolved.length === 0) {
    blockers.push({
      kind: 'no-repository',
      message: `workflow '${root.name}' requires a workspace but no repository resolved for item '${item.externalId}'`,
    })
  }

  const instructions = await discoverInstructionsSection(ports)
  const contextPreview = await previewContextSection(item, ports)
  const profiles = previewProfiles(graph, snapshot, ports.executors, blockers)
  const gates = previewGates(
    graph,
    snapshot,
    item,
    variables,
    resultsFromHypotheticals(hypotheticals),
  )
  const walk =
    validationIssues.length === 0
      ? walkGraph(graph, snapshot, item, variables, hypotheticals)
      : { nodes: [], stopReason: 'invalid-graph', sideEffects: [] as ExpectedSideEffect[] }

  return {
    workflow: {
      name: root.name,
      version: root.version,
      lifecycle,
      validationIssues,
    },
    matching: {
      selection: 'explicit',
      rationale: `workflow '${root.name}'@${root.version} explicitly selected for work item '${item.externalId}'`,
    },
    repositories,
    instructions,
    contextPreview,
    gates,
    path: { nodes: walk.nodes, stopReason: walk.stopReason },
    profiles,
    expectedSideEffects: walk.sideEffects,
    blockers,
  }
}

// ---------------------------------------------------------------------------
// Snapshot resolution (read-only reuse of SnapshotResolver).
// ---------------------------------------------------------------------------

/**
 * Adapts the read port to the DefinitionStore shape SnapshotResolver
 * expects. The resolver only ever calls get/getLifecycle; every write
 * method throws so no code path can mutate through the adapter.
 */
function readOnlyStore(definitions: EvaluateDefinitionReader): DefinitionStore {
  const refuse = (): never => {
    throw new OrchestratorError('evaluate is side-effect free; writes are forbidden', 'policy')
  }
  return {
    get: (kind, name, version) => definitions.get(kind, name, version),
    list: (kind) => definitions.list(kind),
    getLifecycle: (kind, name) => definitions.getLifecycle(kind, name),
    listVersions: async () => refuse(),
    save: async () => refuse(),
    setLifecycle: async () => refuse(),
    saveSnapshot: async () => refuse(),
    getSnapshot: async () => refuse(),
  }
}

async function resolveSnapshotReadOnly(
  definitions: EvaluateDefinitionReader,
  root: DefinitionVersion,
  validationIssues: readonly GraphIssue[],
  blockers: EvaluationBlocker[],
): Promise<ResolvedSnapshot> {
  const degraded: ResolvedSnapshot = {
    id: 'snapshot-evaluate',
    root: { name: root.name, version: root.version },
    definitions: [root],
    createdAt: root.createdAt,
  }
  // SnapshotResolver rejects invalid graphs outright; the report carries
  // the issues instead, so skip resolution and degrade to the root only.
  if (validationIssues.length > 0) return degraded

  const resolver = new SnapshotResolver(readOnlyStore(definitions), {
    next: (prefix) => `${prefix}-evaluate`,
  })
  try {
    // Resolving with the explicit root version skips the root lifecycle
    // check (already reported as a blocker above) while sub-definitions
    // still resolve exactly as a real start would.
    return await resolver.resolve(root.name, root.version)
  } catch (error) {
    blockers.push({
      kind: 'snapshot-resolution',
      message: error instanceof Error ? error.message : String(error),
    })
    return degraded
  }
}

// ---------------------------------------------------------------------------
// Repositories, instructions, and context preview.
// ---------------------------------------------------------------------------

async function resolveRepositoriesSection(
  item: WorkItem,
  ports: EvaluatePorts,
): Promise<EvaluationReport['repositories']> {
  const resolved = new Map<string, ResolvedRepository>()
  if (item.repository) {
    resolved.set(`${item.repository.locator}#primary`, {
      repository: item.repository,
      role: 'primary',
      resolvedBy: 'item-metadata',
    })
  }

  const ruleSet = await ports.mapping?.getRuleSet()
  const rulesEvaluated: Array<{
    ruleId: string
    priority: number
    matched: boolean
    onConflict: 'replace' | 'merge'
  }> = []
  if (ruleSet) {
    const parent = await fetchParent(item, ports.work)
    for (const rule of ruleSet.rules) {
      rulesEvaluated.push({
        ruleId: rule.id,
        priority: rule.priority,
        matched: evaluatePredicate(rule.when, item, parent),
        onConflict: rule.onConflict ?? 'merge',
      })
    }
    for (const entry of resolveRepositories(ruleSet, item, parent)) {
      const key = `${entry.repository.locator}#${entry.role}`
      if (!resolved.has(key)) resolved.set(key, entry)
    }
  }
  return { resolved: [...resolved.values()], rulesEvaluated }
}

async function fetchParent(
  item: WorkItem,
  work: EvaluateWorkReader | undefined,
): Promise<WorkItem | undefined> {
  if (!work) return undefined
  const parentRef = item.relationships.find((relationship) => relationship.kind === 'child-of')
  if (!parentRef) return undefined
  try {
    return await work.get(parentRef.targetExternalId)
  } catch {
    return undefined
  }
}

async function discoverInstructionsSection(
  ports: EvaluatePorts,
): Promise<EvaluationReport['instructions']> {
  const providers = ports.instructionProviders ?? []
  const repositoryPaths = ports.repositoryPaths ?? []
  if (providers.length === 0 || repositoryPaths.length === 0) return []
  const discovered = []
  for (const provider of providers) {
    try {
      discovered.push(...(await provider.discover({ repositoryPaths })))
    } catch {
      // A failing provider contributes nothing to the preview.
    }
  }
  const effective = mergeInstructions(discovered)
  return effective.documents.map((document) => ({
    providerId: document.providerId,
    source: document.source,
    scope: document.scope,
    path: document.path,
    precedence: document.precedence,
  }))
}

async function previewContextSection(
  item: WorkItem,
  ports: EvaluatePorts,
): Promise<EvaluationReport['contextPreview']> {
  const resolvers = ports.contextResolvers ?? []
  if (resolvers.length === 0) return { fragments: [], excluded: [], totalChars: 0 }
  const fragments: ContextFragment[] = []
  for (const resolver of resolvers) {
    try {
      fragments.push(
        ...(await resolver.resolve({
          runId: asId<'run'>('run-evaluate-preview'),
          item,
          traversal: defaultTraversalPolicy,
          attachments: defaultAttachmentPolicy,
          maxTotalChars: CONTEXT_PREVIEW_MAX_CHARS,
        })),
      )
    } catch {
      // A failing resolver contributes nothing to the preview.
    }
  }
  const bundle = assembleContext(fragments, CONTEXT_PREVIEW_MAX_CHARS)
  return {
    fragments: bundle.fragments.map((fragment) => ({
      resolverId: fragment.resolverId,
      kind: fragment.kind,
      title: fragment.title,
      priority: fragment.priority,
      provenance: fragment.provenance,
      chars: fragment.content.length,
    })),
    excluded: bundle.excluded.map((entry) => ({
      title: entry.fragment.title,
      reason: entry.reason,
    })),
    totalChars: bundle.totalChars,
  }
}

// ---------------------------------------------------------------------------
// Profiles and executors.
// ---------------------------------------------------------------------------

function previewProfiles(
  graph: WorkflowGraph,
  snapshot: ResolvedSnapshot,
  executors: EvaluateExecutorReader,
  blockers: EvaluationBlocker[],
): readonly ProfilePreview[] {
  const previews: ProfilePreview[] = []
  for (const node of graph.nodes) {
    if (node.config.kind !== 'agent') continue
    const profileName = node.config.profile?.name ?? graph.defaultProfile?.name
    if (!profileName) {
      const message = `agent node '${node.id}' has no profile and the workflow declares no default profile`
      blockers.push({ kind: 'missing-profile', message })
      previews.push({
        nodeId: node.id,
        profileName: '(none)',
        fallbackChain: [],
        satisfiable: false,
        error: message,
      })
      continue
    }
    try {
      const profile = resolveProfileFromSnapshot(snapshot, profileName)
      const primaryAvailable = executors.has(profile.primary.executor)
      const fallbackChain = (profile.fallback?.chain ?? []).map((selection) => ({
        executor: selection.executor,
        available: executors.has(selection.executor),
      }))
      const satisfiable = primaryAvailable || fallbackChain.some((entry) => entry.available)
      if (!satisfiable) {
        blockers.push({
          kind: 'missing-executor',
          message: `agent node '${node.id}' profile '${profileName}' has no available executor (tried ${[
            profile.primary.executor,
            ...fallbackChain.map((entry) => entry.executor),
          ].join(', ')})`,
        })
      }
      previews.push({
        nodeId: node.id,
        profileName,
        primaryExecutor: profile.primary.executor,
        primaryAvailable,
        fallbackChain,
        satisfiable,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blockers.push({ kind: 'missing-profile', message })
      previews.push({
        nodeId: node.id,
        profileName,
        fallbackChain: [],
        satisfiable: false,
        error: message,
      })
    }
  }
  return previews
}

// ---------------------------------------------------------------------------
// Gate previews.
// ---------------------------------------------------------------------------

interface PredictedResult {
  readonly status: 'succeeded' | 'failed'
  readonly outputs: Readonly<Record<string, unknown>>
  readonly error?: string
}

function resultsFromHypotheticals(
  hypotheticals: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Readonly<Record<string, PredictedResult>> {
  const results: Record<string, PredictedResult> = {}
  for (const [nodeId, outputs] of Object.entries(hypotheticals)) {
    results[nodeId] = { status: 'succeeded', outputs }
  }
  return results
}

/** Node ids referenced through `results.<nodeId>` in an expression. */
function referencedResultNodeIds(expression: string): readonly string[] {
  const ids: string[] = []
  for (const match of expression.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)) {
    const segments = match[0].split('.')
    if (segments[0] === 'results' && segments[1]) ids.push(segments[1])
  }
  return ids
}

function referencesOutputs(expression: string): boolean {
  for (const match of expression.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)) {
    if (match[0] === 'outputs' || match[0].startsWith('outputs.')) return true
  }
  return false
}

function gateScope(
  item: WorkItem,
  domainData: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
  results: Readonly<Record<string, PredictedResult>>,
): Scope {
  return {
    item: {
      title: item.title,
      state: item.state,
      type: item.type ?? '',
      labels: item.labels,
      description: item.description ?? '',
    },
    domain: domainData,
    vars: variables,
    results: resultScope(results),
  }
}

function resultScope(results: Readonly<Record<string, PredictedResult>>): Scope {
  const scope: Record<string, unknown> = {}
  for (const [nodeId, result] of Object.entries(results)) {
    scope[nodeId] = {
      status: result.status,
      succeeded: result.status === 'succeeded',
      failed: result.status === 'failed',
      outputs: result.outputs,
    }
  }
  return scope
}

function composedGatesFor(
  snapshot: ResolvedSnapshot,
  node: GraphNode,
): { gateSetName: string; gateSetVersion: number; gates: readonly Gate[] } | undefined {
  if (node.config.kind !== 'gate') return undefined
  const definition = findInSnapshot(
    snapshot,
    DefinitionKind.GateSet,
    node.config.gateSet.name,
    node.config.gateSet.version,
  )
  if (!definition) return undefined
  const gateSet = definition.document as unknown as GateSet
  const bases: GateSet[] = []
  for (const baseName of gateSet.extends ?? []) {
    const base = findInSnapshot(snapshot, DefinitionKind.GateSet, baseName)
    if (base) bases.push(base.document as unknown as GateSet)
  }
  return {
    gateSetName: gateSet.name,
    gateSetVersion: definition.version,
    gates: composeGateSets(gateSet, bases),
  }
}

function previewGate(
  gate: Gate,
  scope: Scope,
  availableResults: Readonly<Record<string, PredictedResult>>,
): GatePreview {
  const base = { gateId: gate.id, kind: gate.kind, required: gate.required }
  if (gate.kind === 'agent') {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: 'agent-evaluated gate; not run in evaluation',
    }
  }
  if (gate.kind === 'human') {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: 'human approval gate; not requested in evaluation',
    }
  }
  if (gate.check.startsWith('command:')) {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: 'command gate requires a workspace; not executed in evaluation',
    }
  }
  const missing = referencedResultNodeIds(gate.check).filter(
    (nodeId) => availableResults[nodeId] === undefined,
  )
  if (missing.length > 0) {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: `expression references results not provided hypothetically: ${[...new Set(missing)].join(', ')}`,
    }
  }
  try {
    const passed = evaluateScopeExpression(gate.check, scope)
    return {
      ...base,
      outcome: passed ? 'pass' : 'fail',
      reason: passed ? 'expression true' : `expression false: ${gate.check}`,
    }
  } catch (error) {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: `expression error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function previewGates(
  graph: WorkflowGraph,
  snapshot: ResolvedSnapshot,
  item: WorkItem,
  variables: Readonly<Record<string, unknown>>,
  results: Readonly<Record<string, PredictedResult>>,
): readonly GateNodePreview[] {
  const previews: GateNodePreview[] = []
  const scope = gateScope(item, {}, variables, results)
  for (const node of graph.nodes) {
    if (node.config.kind !== 'gate') continue
    const composed = composedGatesFor(snapshot, node)
    if (!composed) {
      previews.push({
        nodeId: node.id,
        gateSetName: node.config.gateSet.name,
        gateSetVersion: node.config.gateSet.version ?? 0,
        gates: [
          {
            gateId: '(gate set)',
            kind: 'deterministic',
            required: true,
            outcome: 'indeterminate',
            reason: `gate set '${node.config.gateSet.name}' not in snapshot`,
          },
        ],
      })
      continue
    }
    previews.push({
      nodeId: node.id,
      gateSetName: composed.gateSetName,
      gateSetVersion: composed.gateSetVersion,
      gates: composed.gates.map((gate) => previewGate(gate, scope, results)),
    })
  }
  return previews
}

// ---------------------------------------------------------------------------
// Determinable path walk. Mirrors the graph engine's activation, effect,
// transition, join, and loop-bound semantics — but instead of executing
// nodes it predicts their settlement (hypothetical outputs, terminals,
// decidable deterministic gates, noop/assumed actions) and stops with
// 'indeterminate:<nodeId>' as soon as an outcome cannot be decided.
// ---------------------------------------------------------------------------

interface WalkOutcome {
  readonly nodes: readonly string[]
  readonly stopReason: string
  readonly sideEffects: readonly ExpectedSideEffect[]
}

function walkGraph(
  graph: WorkflowGraph,
  snapshot: ResolvedSnapshot,
  item: WorkItem,
  variables: Readonly<Record<string, unknown>>,
  hypotheticals: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): WalkOutcome {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, GraphTransition[]>()
  const incoming = new Map<string, GraphTransition[]>()
  for (const transition of graph.transitions) {
    outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), transition])
    incoming.set(transition.to, [...(incoming.get(transition.to) ?? []), transition])
  }

  const results: Record<string, PredictedResult> = {}
  const loopCounters: Record<string, number> = {}
  const activations: Record<string, number> = {}
  const domain: { name?: string; data: Record<string, unknown> } = { data: {} }
  const path: string[] = []
  const sideEffects: ExpectedSideEffect[] = []
  const queue: string[] = []
  let stopReason: string | undefined
  let settlements = 0

  const baseScope = (): Scope => ({
    domain: { name: domain.name, ...domain.data },
    vars: variables,
    results: resultScope(results),
  })

  const applyEffect = (effect: LifecycleEffect | undefined, nodeId: string, scope: Scope) => {
    if (!effect) return
    if (effect.setDomainState !== undefined) domain.name = effect.setDomainState
    for (const [key, expression] of Object.entries(effect.setData ?? {})) {
      try {
        domain.data[key] = evaluateScopeValue(expression, scope)
      } catch {
        // Undecidable data stays unset; conditions over it resolve falsy,
        // matching how the engine treats absent scope references.
      }
    }
    if (effect.project !== undefined) {
      sideEffects.push({
        nodeId,
        kind: 'projection',
        description: `work item would transition to external state '${effect.project}'`,
        details: { target: effect.project },
      })
    }
  }

  const activate = (nodeId: string) => {
    const node = nodesById.get(nodeId)
    if (!node) return
    activations[nodeId] = (activations[nodeId] ?? 0) + 1
    queue.push(nodeId)
    applyEffect(node.onEnter, nodeId, baseScope())
  }

  const joinSatisfied = (node: GraphNode): boolean => {
    const inbound = incoming.get(node.id) ?? []
    const mode = node.join?.mode ?? 'any'
    const entryOffset = node.id === graph.entry ? 1 : 0
    const activated = (activations[node.id] ?? 0) - entryOffset
    const firedCount = inbound.filter((t) => (loopCounters[t.id] ?? 0) > 0).length
    const maxSingleFirings = inbound.reduce((max, t) => Math.max(max, loopCounters[t.id] ?? 0), 0)
    switch (mode) {
      case 'any':
        return maxSingleFirings > activated
      case 'all':
        return firedCount === inbound.length && activated === 0
      case 'min':
        return firedCount >= (node.join?.n ?? inbound.length) && activated === 0
    }
  }

  /** Describe the side effects executing this node would cause. */
  const describeNodeEffects = (node: GraphNode) => {
    const config = node.config
    switch (config.kind) {
      case 'agent':
        sideEffects.push({
          nodeId: node.id,
          kind: 'agent-session',
          description: `agent session would run for node '${node.id}' with profile '${
            config.profile?.name ?? graph.defaultProfile?.name ?? '(none)'
          }'`,
        })
        break
      case 'command':
        sideEffects.push({
          nodeId: node.id,
          kind: 'command',
          description: `command '${config.command}' would run in the workspace`,
          details: { command: config.command },
        })
        break
      case 'action': {
        if (config.action === 'workflow.noop') break
        const argScope: Scope = {
          vars: variables,
          domain: domain.data,
          results: Object.fromEntries(
            Object.entries(results).map(([key, result]) => [
              key,
              { status: result.status, outputs: result.outputs },
            ]),
          ),
        }
        const args: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(config.with ?? {})) {
          if (typeof value === 'string' && value.startsWith('$expr:')) {
            try {
              args[key] = evaluateScopeValue(value.slice('$expr:'.length), argScope)
            } catch {
              args[key] = value
            }
          } else {
            args[key] = value
          }
        }
        sideEffects.push({
          nodeId: node.id,
          kind: 'action',
          description: `action '${config.action}' would execute`,
          details: { action: config.action, args },
        })
        break
      }
      case 'subworkflow':
        sideEffects.push({
          nodeId: node.id,
          kind: 'child-run',
          description: `child run of workflow '${config.workflow.name}' would start`,
          details: { workflow: config.workflow.name },
        })
        break
      case 'fan-out':
        sideEffects.push({
          nodeId: node.id,
          kind: 'child-run',
          description: `fan-out child runs of workflow '${config.workflow.name}' would start (one per item of '${config.items}')`,
          details: { workflow: config.workflow.name, items: config.items },
        })
        break
      case 'human-input':
      case 'wait':
        sideEffects.push({
          nodeId: node.id,
          kind: 'checkpoint',
          description: `durable checkpoint would be taken before suspending on node '${node.id}'`,
        })
        if (
          config.kind === 'human-input' &&
          (config.request.surface === 'work_item' || config.request.surface === 'both') &&
          graph.projection?.comments !== undefined
        ) {
          sideEffects.push({
            nodeId: node.id,
            kind: 'work-item-comment',
            description: `work-item comment would be posted: 'Waiting for input: ${config.request.prompt}'`,
          })
        }
        break
      default:
        break
    }
  }

  /** Predict the node's settlement, or undefined when undecidable. */
  const predict = (node: GraphNode): PredictedResult | undefined => {
    const hypothetical = hypotheticals[node.id]
    if (hypothetical !== undefined) return { status: 'succeeded', outputs: hypothetical }
    const config = node.config
    if (config.kind === 'terminal') return { status: 'succeeded', outputs: {} }
    if (config.kind === 'action') {
      // Real action outputs are unknown; assume success with empty
      // outputs, but only when no downstream condition inspects them.
      const dependsOnOutputs = (outgoing.get(node.id) ?? []).some(
        (transition) =>
          transition.condition !== undefined && referencesOutputs(transition.condition),
      )
      return dependsOnOutputs ? undefined : { status: 'succeeded', outputs: {} }
    }
    if (config.kind === 'gate') {
      const composed = composedGatesFor(snapshot, node)
      if (!composed) return undefined
      const scope = gateScope(item, domain.data, variables, results)
      const previews = composed.gates.map((gate) => previewGate(gate, scope, results))
      if (previews.some((preview) => preview.outcome === 'indeterminate')) return undefined
      const failed = previews.find((preview) => preview.required && preview.outcome === 'fail')
      return {
        status: failed ? 'failed' : 'succeeded',
        outputs: {
          gateSetName: composed.gateSetName,
          gateSetVersion: composed.gateSetVersion,
          passed: failed === undefined,
        },
        ...(failed ? { error: `gate '${failed.gateId}' failed: ${failed.reason}` } : {}),
      }
    }
    return undefined
  }

  activate(graph.entry)

  walk: while (queue.length > 0) {
    if (settlements >= WALK_SETTLEMENT_BACKSTOP) {
      stopReason = 'settlement-limit'
      break
    }
    const nodeId = queue.shift() as string
    const node = nodesById.get(nodeId)
    if (!node) continue

    // Guards run before anything else, exactly as the engine does.
    let guardFailure: string | undefined
    for (const guard of node.guards ?? []) {
      let passed = false
      try {
        passed = evaluateScopeExpression(guard, baseScope())
      } catch (error) {
        guardFailure = `guard error: ${error instanceof Error ? error.message : String(error)}`
        break
      }
      if (!passed) {
        guardFailure = `guard failed: ${guard}`
        break
      }
    }

    let result: PredictedResult
    if (guardFailure !== undefined) {
      result = { status: 'failed', outputs: {}, error: guardFailure }
    } else {
      describeNodeEffects(node)
      const predicted = predict(node)
      if (predicted === undefined) {
        stopReason = `indeterminate:${nodeId}`
        break
      }
      result = predicted
    }

    results[nodeId] = result
    path.push(nodeId)
    settlements += 1

    const settleScope: Scope = {
      outputs: result.outputs,
      node: { status: result.status, error: result.error ?? '' },
      ...baseScope(),
    }
    applyEffect(node.onExit, nodeId, settleScope)

    if (node.config.kind === 'terminal') {
      stopReason = `terminal:${nodeId}`
      break
    }

    let fired = 0
    for (const transition of outgoing.get(nodeId) ?? []) {
      let passes = false
      try {
        passes =
          transition.condition === undefined ||
          evaluateScopeExpression(transition.condition, settleScope)
      } catch {
        passes = false
      }
      if (!passes) continue
      const count = loopCounters[transition.id] ?? 0
      if (transition.loopBound !== undefined && count >= transition.loopBound) {
        stopReason = `loop-bound:${transition.id}`
        break walk
      }
      loopCounters[transition.id] = count + 1
      fired += 1
      applyEffect(transition.effects, nodeId, settleScope)
      const target = nodesById.get(transition.to)
      if (target && joinSatisfied(target)) activate(target.id)
    }

    if (fired === 0 && result.status === 'failed') {
      stopReason = `failed:${nodeId}`
      break
    }
  }

  return { nodes: path, stopReason: stopReason ?? 'stalled', sideEffects }
}
