/**
 * Behavioral contract every AgentProvider (and the native AgentRuntime,
 * which satisfies the same operational shape per ADR-0003) must satisfy,
 * independent of whether it drives an in-process loop or an external
 * CLI/SDK. Run against each executor's own scripted fake — see
 * packages/runtime and packages/providers/agent-* for wiring.
 *
 * A scenario's `provider` must never resolve `completeNaturally()`'s
 * terminal state on its own: the underlying fake should hang until driven,
 * so the cancel-before-completion test can reliably race a real cancel()
 * against natural completion instead of hoping timing works out.
 */

import type { AgentEvent, AgentOutcome, AgentRunHandle, AgentRunRequest } from '@overture/core'
import { describe, expect, it } from 'vitest'

const ALL_OUTCOMES: readonly AgentOutcome[] = [
  'GOAL_COMPLETED',
  'GOAL_BLOCKED',
  'BUDGET_EXHAUSTED',
  'POLICY_BLOCKED',
  'HUMAN_INPUT_REQUIRED',
  'FATAL_FAILURE',
  'CANCELLED',
]

export interface AgentProviderContractScenario {
  /** A start-capable executor: an AgentProvider or the native AgentRuntime. */
  readonly provider: { start(request: AgentRunRequest): Promise<AgentRunHandle> }
  /** Builds a fresh, valid AgentRunRequest for this scenario. */
  makeRequest(): AgentRunRequest
  /** Drives the underlying fake, after start(), to a GOAL_COMPLETED-shaped finish. */
  completeNaturally(): void | Promise<void>
  /** Drives the underlying fake, after start(), to a non-success terminal outcome. Optional. */
  scriptFailure?(): void | Promise<void>
  /** Outcomes cancel() may legitimately resolve with. Defaults to ['CANCELLED']. */
  readonly cancellationOutcomes?: readonly AgentOutcome[]
}

async function collectEvents(handle: AgentRunHandle): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of handle.events()) events.push(event)
  return events
}

export function describeAgentProviderContract(
  name: string,
  makeScenario: () => AgentProviderContractScenario | Promise<AgentProviderContractScenario>,
): void {
  describe(`AgentProvider contract: ${name}`, () => {
    it('start() returns a handle whose sessionId matches the request', async () => {
      const scenario = await makeScenario()
      const request = scenario.makeRequest()
      const handle = await scenario.provider.start(request)
      expect(handle.sessionId).toBe(request.sessionId)
      await scenario.completeNaturally()
      await handle.result()
    })

    it('events() ends with agent.completed carrying the same result as result(), then terminates', async () => {
      const scenario = await makeScenario()
      const handle = await scenario.provider.start(scenario.makeRequest())
      const eventsPromise = collectEvents(handle)
      await scenario.completeNaturally()
      const [events, result] = await Promise.all([eventsPromise, handle.result()])

      expect(events.length).toBeGreaterThan(0)
      const last = events.at(-1)
      expect(last?.type).toBe('agent.completed')
      if (last?.type === 'agent.completed') expect(last.result).toEqual(result)
    })

    it('result().outcome is a member of the closed AgentOutcome set', async () => {
      const scenario = await makeScenario()
      const handle = await scenario.provider.start(scenario.makeRequest())
      await scenario.completeNaturally()
      const result = await handle.result()
      expect(ALL_OUTCOMES).toContain(result.outcome)
    })

    it('result().usage has a well-formed UsageRecord shape', async () => {
      const scenario = await makeScenario()
      const handle = await scenario.provider.start(scenario.makeRequest())
      await scenario.completeNaturally()
      const result = await handle.result()

      expect(typeof result.usage.provider).toBe('string')
      expect(result.usage.provider.length).toBeGreaterThan(0)
      expect(result.usage.tokens.inputTokens).toBeGreaterThanOrEqual(0)
      expect(result.usage.tokens.outputTokens).toBeGreaterThanOrEqual(0)
      expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.usage.turns).toBeGreaterThanOrEqual(0)
      expect(result.usage.subagents).toBeGreaterThanOrEqual(0)
    })

    it('cancel() before completion resolves with a documented cancellation outcome', async () => {
      const scenario = await makeScenario()
      const handle = await scenario.provider.start(scenario.makeRequest())
      await handle.cancel('contract test cancellation')
      const result = await handle.result()
      const allowed = scenario.cancellationOutcomes ?? ['CANCELLED']
      expect(allowed).toContain(result.outcome)
    })

    it('a consumer started before completion still observes the terminal event (single-consumer)', async () => {
      const scenario = await makeScenario()
      const handle = await scenario.provider.start(scenario.makeRequest())
      const iterator = handle.events()[Symbol.asyncIterator]()
      await scenario.completeNaturally()

      const seen: AgentEvent[] = []
      while (true) {
        const { value, done } = await iterator.next()
        if (done) break
        seen.push(value)
      }
      expect(seen.at(-1)?.type).toBe('agent.completed')
    })

    it('scriptFailure(), when supported, ends in a non-GOAL_COMPLETED outcome with a non-empty summary', async () => {
      const scenario = await makeScenario()
      if (!scenario.scriptFailure) return

      const handle = await scenario.provider.start(scenario.makeRequest())
      await scenario.scriptFailure()
      const result = await handle.result()

      expect(result.outcome).not.toBe('GOAL_COMPLETED')
      expect(result.summary.length).toBeGreaterThan(0)
    })
  })
}
