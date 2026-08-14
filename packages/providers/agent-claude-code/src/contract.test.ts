import { asId } from '@overture/core'
import { describeAgentProviderContract } from '@overture/testkit'
import { ClaudeCodeAgentProvider } from './provider.js'
import { controllableQuery, resultError, resultSuccess } from './test-helpers.js'

/**
 * Wires the shared AgentProvider contract suite against a
 * ClaudeCodeAgentProvider backed by `controllableQuery()`, which only
 * yields SDK messages when explicitly pushed — so the cancel-before-
 * completion test races a real cancel() against a fake that cannot settle
 * on its own, instead of hoping timing works out.
 */
describeAgentProviderContract('ClaudeCodeAgentProvider', () => {
  const ctl = controllableQuery()
  const provider = new ClaudeCodeAgentProvider({
    auth: { kind: 'api-key', apiKey: async () => 'sk-contract-test' },
    queryImpl: ctl.impl,
  })

  return {
    provider,
    makeRequest: () => ({
      runId: asId('contract-run'),
      sessionId: asId('contract-session'),
      goal: { goal: 'contract test goal' },
    }),
    completeNaturally: () => {
      ctl.push(resultSuccess({ result: 'contract test completed' }))
      ctl.end()
    },
    scriptFailure: () => {
      ctl.push(resultError('error_during_execution'))
      ctl.end()
    },
  }
})
