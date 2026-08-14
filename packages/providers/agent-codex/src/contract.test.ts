import { asId } from '@overture/core'
import { describeAgentProviderContract } from '@overture/testkit'
import { CodexAgentProvider } from './provider.js'
import { fakeSpawner, jsonl } from './test-helpers.js'

/**
 * Wires the shared AgentProvider contract suite against a
 * CodexAgentProvider backed by a fake spawner. `autoCloseOnKill: true` so
 * `cancel()` alone (SIGKILL) reaches a terminal state without another
 * driving step — a real killed process eventually closes the same way.
 */
describeAgentProviderContract('CodexAgentProvider', () => {
  const { spawner, child } = fakeSpawner({ autoCloseOnKill: true })
  const provider = new CodexAgentProvider({ auth: { kind: 'cli-session' }, spawner })

  return {
    provider,
    makeRequest: () => ({
      runId: asId('contract-run'),
      sessionId: asId('contract-session'),
      goal: { goal: 'contract test goal' },
    }),
    completeNaturally: () => {
      child.emitStdout(
        jsonl(
          { type: 'thread.started', thread_id: 'contract-thread' },
          { type: 'turn.started' },
          {
            type: 'item.completed',
            item: { id: 'item_0', type: 'agent_message', text: 'contract test completed' },
          },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          },
        ),
      )
      child.emitClose(0)
    },
    scriptFailure: () => {
      child.emitStdout(
        jsonl(
          { type: 'thread.started', thread_id: 'contract-thread-fail' },
          { type: 'turn.started' },
          { type: 'turn.failed', error: { message: 'contract scripted failure' } },
        ),
      )
      child.emitClose(1)
    },
  }
})
