import { describe, expect, it } from 'vitest'
import { CallbackApprovalGateway, DenyAllApprovalGateway } from './approvals.js'
import { RuleBasedPolicyEngine, workspaceCodingRules } from './rule-engine.js'

describe('RuleBasedPolicyEngine', () => {
  it('denies by default when no rule matches', () => {
    const engine = new RuleBasedPolicyEngine({ rules: [] })
    expect(engine.evaluate({ capability: 'process.execute' }).effect).toBe('deny')
  })

  it('applies the first matching rule', () => {
    const engine = new RuleBasedPolicyEngine({
      rules: [
        { id: 'deny-secrets', capability: 'filesystem.read', target: '**/.env', effect: 'deny' },
        { id: 'allow-read', capability: 'filesystem.read', effect: 'allow' },
      ],
    })
    expect(engine.evaluate({ capability: 'filesystem.read', target: 'app/.env' }).effect).toBe(
      'deny',
    )
    expect(engine.evaluate({ capability: 'filesystem.read', target: 'app/index.ts' }).effect).toBe(
      'allow',
    )
  })

  it('matches capability exactly', () => {
    const engine = new RuleBasedPolicyEngine({
      rules: [{ id: 'allow-read', capability: 'filesystem.read', effect: 'allow' }],
    })
    expect(engine.evaluate({ capability: 'filesystem.write' }).effect).toBe('deny')
  })

  it('supports ask and sandbox-only effects with rule attribution', () => {
    const engine = new RuleBasedPolicyEngine({
      rules: [
        { id: 'ask-push', capability: 'git.write', target: 'push:**', effect: 'ask' },
        { id: 'sandbox-net', capability: 'network.connect', effect: 'sandbox-only' },
      ],
    })
    const push = engine.evaluate({ capability: 'git.write', target: 'push:origin/main' })
    expect(push.effect).toBe('ask')
    expect(push.ruleId).toBe('ask-push')
    expect(engine.evaluate({ capability: 'network.connect', target: 'example.com' }).effect).toBe(
      'sandbox-only',
    )
  })

  it('single * does not cross path separators; ** does', () => {
    const engine = new RuleBasedPolicyEngine({
      rules: [{ id: 'r', capability: 'filesystem.write', target: 'src/*.ts', effect: 'allow' }],
    })
    expect(engine.evaluate({ capability: 'filesystem.write', target: 'src/a.ts' }).effect).toBe(
      'allow',
    )
    expect(engine.evaluate({ capability: 'filesystem.write', target: 'src/deep/a.ts' }).effect).toBe(
      'deny',
    )
  })

  it('workspaceCodingRules allow the standard coding capabilities', () => {
    const engine = new RuleBasedPolicyEngine({ rules: workspaceCodingRules() })
    expect(engine.evaluate({ capability: 'process.execute', target: 'npm test' }).effect).toBe(
      'allow',
    )
    expect(engine.evaluate({ capability: 'secret.read', target: 'x' }).effect).toBe('deny')
  })
})

describe('approval gateways', () => {
  it('DenyAllApprovalGateway records and denies', async () => {
    const gateway = new DenyAllApprovalGateway()
    const approved = await gateway.requestApproval(
      { capability: 'git.write' },
      { effect: 'ask' },
    )
    expect(approved).toBe(false)
    expect(gateway.denied).toHaveLength(1)
  })

  it('CallbackApprovalGateway delegates to the callback', async () => {
    const gateway = new CallbackApprovalGateway(async () => true)
    expect(await gateway.requestApproval({ capability: 'git.write' }, { effect: 'ask' })).toBe(true)
  })

  it('CallbackApprovalGateway fails closed on timeout', async () => {
    const gateway = new CallbackApprovalGateway(() => new Promise(() => {}), 50)
    expect(await gateway.requestApproval({ capability: 'git.write' }, { effect: 'ask' })).toBe(
      false,
    )
  })
})
