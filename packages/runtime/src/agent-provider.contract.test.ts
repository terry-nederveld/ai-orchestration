import {
  type AgentRunRequest,
  asId,
  Capability,
  CapabilitySet,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  OrchestratorError,
  type PolicyEngine,
  type ProviderInfo,
} from '@overture/core'
import {
  describeAgentProviderContract,
  ScriptedModelProvider,
  type ScriptedTurn,
} from '@overture/testkit'
import { NativeAgentRuntime } from './agent-loop.js'
import { AsyncQueue } from './async-queue.js'
import { DefaultToolRegistry } from './registry.js'

/**
 * Wires the shared AgentProvider contract suite against NativeAgentRuntime.
 * NativeAgentRuntime satisfies the same AgentRuntime shape as an
 * AgentProvider (ADR-0003), so it must pass the same contract.
 *
 * The runtime drives its ModelProvider's stream() calls turn-by-turn with
 * no artificial delay, so a plain pre-scripted ScriptedModelProvider would
 * resolve "naturally" the instant it's started — racing the
 * cancel-before-completion test. `drivenModel()` wraps a fresh single-turn
 * ScriptedModelProvider per queued turn behind an AsyncQueue: stream() only
 * resolves once a turn is pushed (or the abort signal fires), so it hangs
 * exactly like the fake spawners/queries the other three adapters use.
 */
function drivenModel(): { model: ModelProvider; push: (turn: ScriptedTurn) => void } {
  const queue = new AsyncQueue<ScriptedTurn>()
  const info: ProviderInfo = {
    id: 'driven-model',
    displayName: 'Driven Model',
    kind: 'model',
    consumption: 'local',
    authentication: ['none'],
  }

  function abortedError(signal: AbortSignal): OrchestratorError {
    return new OrchestratorError('driven model aborted', 'internal', {
      retryable: false,
      cause: signal.reason,
    })
  }

  function nextTurn(signal?: AbortSignal): Promise<ScriptedTurn> {
    const pending = queue[Symbol.asyncIterator]()
      .next()
      .then((r) => {
        if (r.done) throw new Error('driven model queue closed before a turn was pushed')
        return r.value
      })
    if (!signal) return pending
    if (signal.aborted) return Promise.reject(abortedError(signal))

    return new Promise<ScriptedTurn>((resolve, reject) => {
      const onAbort = () => reject(abortedError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        (turn) => {
          signal.removeEventListener('abort', onAbort)
          resolve(turn)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  const model: ModelProvider = {
    info,
    capabilities: () => CapabilitySet.of(Capability.Chat, Capability.ToolUse, Capability.Streaming),
    detect: async () => ({ installed: true, authenticated: true, available: true }),
    listModels: async () => [{ id: 'driven-model' }],
    complete: async (request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> => {
      const turn = await nextTurn(signal)
      return new ScriptedModelProvider([turn]).complete(request, signal)
    },
    stream: (request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> => {
      async function* generate() {
        const turn = await nextTurn(signal)
        yield* new ScriptedModelProvider([turn]).stream(request, signal)
      }
      return generate()
    },
  }

  return { model, push: (turn) => queue.push(turn) }
}

const allowAll: PolicyEngine = { evaluate: () => ({ effect: 'allow' }) }

describeAgentProviderContract('NativeAgentRuntime', () => {
  const { model, push } = drivenModel()
  const runtime = new NativeAgentRuntime({
    model,
    defaultModel: 'driven-model',
    tools: new DefaultToolRegistry(),
    policy: allowAll,
    retry: { baseDelayMs: 1 },
  })

  return {
    provider: runtime,
    makeRequest: (): AgentRunRequest => ({
      runId: asId('contract-run'),
      sessionId: asId('contract-session'),
      goal: { goal: 'contract test goal' },
    }),
    completeNaturally: () => {
      push({
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'contract test completed' },
      })
    },
    scriptFailure: () => {
      push({ kind: 'fail', error: 'contract scripted failure' })
    },
  }
})
