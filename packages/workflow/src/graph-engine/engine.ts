/**
 * Durable graph engine (ADR-0017). A tick is a resumable reducer over
 * persisted RunGraphState: execute runnable nodes, settle results, fire
 * declared transitions, enforce joins and loop bounds, and return — the
 * caller persists state after every tick. Nodes that yield a wait suspend
 * the run; a later tick with the wait's satisfaction re-executes them. The
 * engine performs no I/O of its own: node work happens in injected
 * executors, external projections are returned for the caller to apply.
 */

import type {
  Clock,
  DomainState,
  GraphNode,
  GraphNodeKind,
  GraphNodeResult,
  HumanInputRequestSpec,
  LifecycleEffect,
  RunGraphState,
  TerminalNodeConfig,
  WaitSatisfaction,
  WaitSpec,
  WorkflowGraph,
} from '@overture/core'
import { systemClock } from '@overture/core'
import { evaluateScopeExpression, evaluateScopeValue, type Scope } from './scope-expr.js'

export type NodeYield =
  | {
      readonly type: 'result'
      readonly status: 'succeeded' | 'failed'
      readonly outputs?: Readonly<Record<string, unknown>>
      readonly error?: string
    }
  | { readonly type: 'wait'; readonly spec: WaitSpec; readonly request?: HumanInputRequestSpec }

export interface NodeExecutionContext {
  readonly runId: string
  readonly node: GraphNode
  readonly attempt: number
  readonly variables: Readonly<Record<string, unknown>>
  readonly domain: DomainState
  readonly nodeResults: Readonly<Record<string, GraphNodeResult>>
  /** Present when this tick carries a satisfaction for this node's wait. */
  readonly satisfaction?: WaitSatisfaction
  readonly signal: AbortSignal
}

export type GraphNodeExecutor = (
  node: GraphNode,
  context: NodeExecutionContext,
) => Promise<NodeYield>

export type GraphNodeExecutors = Partial<Record<GraphNodeKind, GraphNodeExecutor>>

export interface PendingWait {
  readonly nodeId: string
  readonly spec: WaitSpec
  readonly request?: HumanInputRequestSpec
}

export type GraphEngineEvent =
  | { readonly type: 'node.activated'; readonly nodeId: string; readonly attempt: number }
  | {
      readonly type: 'node.settled'
      readonly nodeId: string
      readonly status: GraphNodeResult['status']
      readonly attempt: number
    }
  | {
      readonly type: 'transition.taken'
      readonly transitionId: string
      readonly from: string
      readonly to: string
    }
  | { readonly type: 'wait.opened'; readonly nodeId: string; readonly kind: string }
  | { readonly type: 'domain_state.changed'; readonly state: string }

export interface GraphTickInput {
  readonly graph: WorkflowGraph
  readonly state: RunGraphState
  readonly executors: GraphNodeExecutors
  /** Satisfactions for nodes previously suspended on waits, by node id. */
  readonly satisfactions?: Readonly<Record<string, WaitSatisfaction>>
  readonly clock?: Clock
  readonly signal?: AbortSignal
  readonly onEvent?: (event: GraphEngineEvent) => void
  /** Backstop against runaway ticks. */
  readonly maxSettlementsPerTick?: number
}

export type GraphRunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export interface GraphTickOutcome {
  readonly state: RunGraphState
  readonly status: GraphRunStatus
  readonly newWaits: readonly PendingWait[]
  /** External projections requested by effects this tick, in order. */
  readonly projections: readonly string[]
  readonly terminal?: TerminalNodeConfig
  readonly error?: string
}

interface MutableState {
  activeNodeIds: Set<string>
  waitingNodeIds: Set<string>
  nodeResults: Record<string, GraphNodeResult>
  resultHistory: GraphNodeResult[]
  loopCounters: Record<string, number>
  activations: Record<string, number>
  domain: { name?: string; data: Record<string, unknown> }
  variables: Record<string, unknown>
}

export class GraphEngine {
  async tick(input: GraphTickInput): Promise<GraphTickOutcome> {
    const clock = input.clock ?? systemClock
    const signal = input.signal ?? new AbortController().signal
    const graph = input.graph
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
    const outgoing = groupTransitions(graph)
    const incoming = groupIncoming(graph)

    const mutable = thaw(input.state)
    const newWaits: PendingWait[] = []
    const projections: string[] = []
    let terminal: TerminalNodeConfig | undefined
    let fatalError: string | undefined
    let settlements = 0
    const maxSettlements = input.maxSettlementsPerTick ?? 1_000

    const emit = (event: GraphEngineEvent) => input.onEvent?.(event)

    const applyEffect = (effect: LifecycleEffect | undefined, scope: Scope) => {
      if (!effect) return
      if (effect.setDomainState !== undefined) {
        mutable.domain.name = effect.setDomainState
        emit({ type: 'domain_state.changed', state: effect.setDomainState })
      }
      if (effect.setData) {
        for (const [key, expression] of Object.entries(effect.setData)) {
          mutable.domain.data[key] = evaluateScopeValue(expression, scope)
        }
      }
      if (effect.project !== undefined) projections.push(effect.project)
    }

    const baseScope = (): Scope => ({
      domain: { name: mutable.domain.name, ...mutable.domain.data },
      vars: mutable.variables,
      results: resultScope(mutable.nodeResults),
    })

    const activate = (nodeId: string) => {
      const node = nodesById.get(nodeId)
      if (!node) return
      mutable.activations[nodeId] = (mutable.activations[nodeId] ?? 0) + 1
      mutable.activeNodeIds.add(nodeId)
      mutable.waitingNodeIds.delete(nodeId)
      emit({ type: 'node.activated', nodeId, attempt: mutable.activations[nodeId] ?? 1 })
      applyEffect(node.onEnter, baseScope())
    }

    // Fresh run: activate the entry node.
    if (
      mutable.activeNodeIds.size === 0 &&
      mutable.waitingNodeIds.size === 0 &&
      Object.keys(mutable.activations).length === 0
    ) {
      activate(graph.entry)
    }

    const settleNode = (node: GraphNode, result: GraphNodeResult): 'continue' | 'stop' => {
      mutable.activeNodeIds.delete(node.id)
      mutable.waitingNodeIds.delete(node.id)
      mutable.nodeResults[node.id] = result
      mutable.resultHistory.push(result)
      settlements += 1
      emit({
        type: 'node.settled',
        nodeId: node.id,
        status: result.status,
        attempt: result.attempt,
      })

      const scope: Scope = {
        outputs: result.outputs,
        node: { status: result.status, error: result.error ?? '' },
        ...baseScope(),
      }
      applyEffect(node.onExit, scope)

      if (node.config.kind === 'terminal') {
        terminal = node.config
        return 'stop'
      }

      // Retry failed nodes locally before transitions see the failure.
      if (result.status === 'failed' && node.retry && result.attempt < node.retry.maxAttempts) {
        activate(node.id)
        return 'continue'
      }

      // Fire declared transitions in declaration order.
      let fired = 0
      for (const transition of outgoing.get(node.id) ?? []) {
        const passes =
          transition.condition === undefined || evaluateScopeExpression(transition.condition, scope)
        if (!passes) continue
        const count = mutable.loopCounters[transition.id] ?? 0
        if (transition.loopBound !== undefined && count >= transition.loopBound) {
          fatalError = `loop bound exceeded on transition '${transition.id}' (${transition.loopBound})`
          return 'stop'
        }
        mutable.loopCounters[transition.id] = count + 1
        fired += 1
        emit({
          type: 'transition.taken',
          transitionId: transition.id,
          from: transition.from,
          to: transition.to,
        })
        applyEffect(transition.effects, scope)

        const target = nodesById.get(transition.to)
        if (!target) continue
        if (joinSatisfied(target, incoming, mutable, graph.entry)) {
          activate(target.id)
        }
      }

      if (fired === 0 && result.status === 'failed') {
        fatalError = `node '${node.id}' failed with no matching transition: ${result.error ?? 'unknown error'}`
        return 'stop'
      }
      return 'continue'
    }

    // Main loop: execute runnable nodes until quiescent or stopped.
    while (!signal.aborted && terminal === undefined && fatalError === undefined) {
      if (settlements >= maxSettlements) {
        fatalError = `tick settlement backstop exceeded (${maxSettlements})`
        break
      }
      const runnable = [...mutable.activeNodeIds]
        .filter(
          (nodeId) =>
            !mutable.waitingNodeIds.has(nodeId) || input.satisfactions?.[nodeId] !== undefined,
        )
        .sort()
      if (runnable.length === 0) break

      const executions = await Promise.all(
        runnable.map(async (nodeId) => {
          const node = nodesById.get(nodeId)
          if (!node) {
            return {
              nodeId,
              yield: {
                type: 'result',
                status: 'failed',
                error: `unknown node '${nodeId}'`,
              } as NodeYield,
              startedAt: clock.now(),
            }
          }
          const startedAt = clock.now()
          const attempt = mutable.activations[nodeId] ?? 1
          const satisfaction = input.satisfactions?.[nodeId]
          const consumedSatisfaction = mutable.waitingNodeIds.has(nodeId)

          // Guards run before the executor; a failing guard fails the node.
          for (const guard of node.guards ?? []) {
            let passed = false
            let guardError: string | undefined
            try {
              passed = evaluateScopeExpression(guard, baseScope())
            } catch (error) {
              guardError = error instanceof Error ? error.message : String(error)
            }
            if (!passed) {
              return {
                nodeId,
                yield: {
                  type: 'result',
                  status: 'failed',
                  error: guardError ? `guard error: ${guardError}` : `guard failed: ${guard}`,
                } as NodeYield,
                startedAt,
              }
            }
          }

          const executor = input.executors[node.config.kind]
          if (!executor) {
            return {
              nodeId,
              yield: {
                type: 'result',
                status: 'failed',
                error: `no executor for node kind '${node.config.kind}'`,
              } as NodeYield,
              startedAt,
            }
          }
          try {
            const yielded = await executor(node, {
              runId: String(input.state.runId),
              node,
              attempt,
              variables: mutable.variables,
              domain: {
                ...(mutable.domain.name !== undefined ? { name: mutable.domain.name } : {}),
                data: mutable.domain.data,
              },
              nodeResults: mutable.nodeResults,
              ...(consumedSatisfaction && satisfaction ? { satisfaction } : {}),
              signal,
            })
            return { nodeId, yield: yielded, startedAt }
          } catch (error) {
            return {
              nodeId,
              yield: {
                type: 'result',
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              } as NodeYield,
              startedAt,
            }
          }
        }),
      )

      for (const execution of executions) {
        const node = nodesById.get(execution.nodeId)
        if (!node) continue
        if (execution.yield.type === 'wait') {
          if (!mutable.waitingNodeIds.has(execution.nodeId)) {
            mutable.waitingNodeIds.add(execution.nodeId)
            newWaits.push({
              nodeId: execution.nodeId,
              spec: execution.yield.spec,
              ...(execution.yield.request ? { request: execution.yield.request } : {}),
            })
            emit({
              type: 'wait.opened',
              nodeId: execution.nodeId,
              kind: execution.yield.spec.kind,
            })
          }
          continue
        }
        const result: GraphNodeResult = {
          nodeId: execution.nodeId,
          attempt: mutable.activations[execution.nodeId] ?? 1,
          status: execution.yield.status,
          outputs: execution.yield.outputs ?? {},
          ...(execution.yield.error !== undefined ? { error: execution.yield.error } : {}),
          startedAt: execution.startedAt,
          settledAt: clock.now(),
        }
        const control = settleNode(node, result)
        if (control === 'stop') break
      }
    }

    const frozen = freeze(input.state, mutable, clock.now())

    if (signal.aborted) {
      return { state: frozen, status: 'cancelled', newWaits, projections }
    }
    if (fatalError !== undefined) {
      return { state: frozen, status: 'failed', newWaits, projections, error: fatalError }
    }
    if (terminal !== undefined) {
      const status: GraphRunStatus =
        terminal.outcome === 'completed'
          ? 'completed'
          : terminal.outcome === 'blocked'
            ? 'blocked'
            : 'failed'
      return { state: frozen, status, newWaits, projections, terminal }
    }
    if (mutable.waitingNodeIds.size > 0) {
      return { state: frozen, status: 'waiting', newWaits, projections }
    }
    if (mutable.activeNodeIds.size > 0) {
      // Runnable set was empty yet actives remain: internal inconsistency.
      return {
        state: frozen,
        status: 'failed',
        newWaits,
        projections,
        error: 'engine inconsistency: active nodes without runnable work',
      }
    }
    return {
      state: frozen,
      status: 'failed',
      newWaits,
      projections,
      error: 'workflow stalled: no path to a terminal node',
    }
  }
}

function groupTransitions(graph: WorkflowGraph) {
  const map = new Map<string, WorkflowGraph['transitions'][number][]>()
  for (const transition of graph.transitions) {
    const list = map.get(transition.from) ?? []
    list.push(transition)
    map.set(transition.from, list)
  }
  return map
}

function groupIncoming(graph: WorkflowGraph) {
  const map = new Map<string, WorkflowGraph['transitions'][number][]>()
  for (const transition of graph.transitions) {
    const list = map.get(transition.to) ?? []
    list.push(transition)
    map.set(transition.to, list)
  }
  return map
}

function joinSatisfied(
  node: GraphNode,
  incoming: ReadonlyMap<string, WorkflowGraph['transitions'][number][]>,
  mutable: MutableState,
  entryNodeId: string,
): boolean {
  const inbound = incoming.get(node.id) ?? []
  const mode = node.join?.mode ?? 'any'
  // The entry node's initial activation happens without a transition
  // firing; exclude it from join accounting so loops back to the entry
  // (and self-loops on it) still re-activate correctly.
  const entryOffset = node.id === entryNodeId ? 1 : 0
  const activations = (mutable.activations[node.id] ?? 0) - entryOffset
  const firedCount = inbound.filter(
    (transition) => (mutable.loopCounters[transition.id] ?? 0) > 0,
  ).length
  const maxSingleFirings = inbound.reduce(
    (max, transition) => Math.max(max, mutable.loopCounters[transition.id] ?? 0),
    0,
  )
  switch (mode) {
    case 'any':
      // One activation per arrival round: a two-branch diamond activates
      // once, while a loop transition firing again re-activates. Entry
      // nodes (no inbound) only ever activate via the explicit entry path.
      return maxSingleFirings > activations
    case 'all':
      return firedCount === inbound.length && activations === 0
    case 'min':
      return firedCount >= (node.join?.n ?? inbound.length) && activations === 0
  }
}

function resultScope(results: Readonly<Record<string, GraphNodeResult>>): Scope {
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

function thaw(state: RunGraphState): MutableState {
  return {
    activeNodeIds: new Set(state.activeNodeIds),
    waitingNodeIds: new Set(state.waitingNodeIds),
    nodeResults: { ...state.nodeResults },
    resultHistory: [...state.resultHistory],
    loopCounters: { ...state.loopCounters },
    activations: { ...state.activations },
    domain: {
      ...(state.domain.name !== undefined ? { name: state.domain.name } : {}),
      data: { ...state.domain.data },
    },
    variables: { ...state.variables },
  }
}

function freeze(previous: RunGraphState, mutable: MutableState, at: Date): RunGraphState {
  return {
    ...previous,
    activeNodeIds: [...mutable.activeNodeIds].sort(),
    waitingNodeIds: [...mutable.waitingNodeIds].sort(),
    nodeResults: mutable.nodeResults,
    resultHistory: mutable.resultHistory,
    loopCounters: mutable.loopCounters,
    activations: mutable.activations,
    domain: {
      ...(mutable.domain.name !== undefined ? { name: mutable.domain.name } : {}),
      data: mutable.domain.data,
    },
    variables: mutable.variables,
    updatedAt: at,
  }
}
