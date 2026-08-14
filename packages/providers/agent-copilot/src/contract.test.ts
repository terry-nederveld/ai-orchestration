import { asId } from '@overture/core'
import { describeAgentProviderContract } from '@overture/testkit'
import { CopilotAgentProvider } from './provider.js'
import { fakeSpawner } from './test-helpers.js'

/**
 * Wires the shared AgentProvider contract suite against a
 * CopilotAgentProvider backed by a fake spawner. `autoCloseOnKill: true` so
 * `cancel()` alone (SIGKILL) reaches a terminal state without another
 * driving step — a real killed process eventually closes the same way.
 */
describeAgentProviderContract('CopilotAgentProvider', () => {
  const { spawner, child } = fakeSpawner({ autoCloseOnKill: true })
  const provider = new CopilotAgentProvider({ auth: { kind: 'cli-session' }, spawner })

  return {
    provider,
    makeRequest: () => ({
      runId: asId('contract-run'),
      sessionId: asId('contract-session'),
      goal: { goal: 'contract test goal' },
    }),
    completeNaturally: () => {
      child.emitStdout('contract test completed\n')
      child.emitClose(0)
    },
    scriptFailure: () => {
      child.emitStderr('contract scripted failure\n')
      child.emitClose(1)
    },
  }
})
