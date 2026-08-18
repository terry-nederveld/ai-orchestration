/**
 * Flagship A — Autonomous Delivery (mission §Flagship A, §34).
 *
 * Ranked-backlog item → Definition of Ready → plan → implement → test →
 * review (structured) → bounded remediation loop → Definition of Done →
 * conventional commit → pull request → work-item update → complete.
 * Durable by construction: any agent ambiguity or human gate suspends the
 * run on a persisted wait with a git-branch checkpoint.
 *
 * The test command is a literal; fork the template to change it (command
 * nodes are never interpolated — a security decision, ADR-0016).
 */

import type { GateSet, WorkflowGraph } from '@overture/core'

export const DELIVERY_WORKFLOW_NAME = 'autonomous-delivery'
export const DELIVERY_DOR_NAME = 'delivery-definition-of-ready'
export const DELIVERY_DOD_NAME = 'delivery-definition-of-done'

export const deliveryDefinitionOfReady: GateSet = {
  name: DELIVERY_DOR_NAME,
  description: 'The item is ready for autonomous implementation.',
  gates: [
    {
      id: 'has-description',
      description: 'The work item has a non-empty description.',
      kind: 'deterministic',
      check: "item.description != ''",
      required: true,
    },
    {
      id: 'acceptance-inferable',
      description: 'Acceptance criteria are stated or clearly inferable.',
      kind: 'agent',
      check:
        'Read the work item context. Decide whether the acceptance criteria are stated or clearly inferable from it. If they are vague or contradictory, fail.',
      required: true,
      remediation: {
        goal: 'Derive concrete acceptance criteria from the work item and record them in your report so the gate can re-evaluate.',
        maxAttempts: 1,
      },
    },
  ],
}

export const deliveryDefinitionOfDone: GateSet = {
  name: DELIVERY_DOD_NAME,
  description: 'The change is complete, validated, and delivery-ready.',
  gates: [
    {
      id: 'tests-pass',
      description: 'The test suite passes in the workspace.',
      kind: 'deterministic',
      check: 'command: npm test',
      required: true,
    },
    {
      id: 'review-clean',
      description: 'The independent review found no unresolved findings.',
      kind: 'deterministic',
      check:
        'results.review.outputs.approved == true || results.re_review.outputs.approved == true',
      required: true,
    },
  ],
}

export const deliveryWorkflow: WorkflowGraph = {
  name: DELIVERY_WORKFLOW_NAME,
  description:
    'Autonomous end-to-end delivery: readiness gate, plan, implement, test, independent review with bounded remediation, done gate, conventional commit, and pull request — suspending durably whenever a human is genuinely needed.',
  entry: 'dor',
  defaultProfile: { name: 'delivery-default' },
  workspace: { strategy: 'git-worktree', retention: 'on-failure' },
  domainStates: ['ready', 'planning', 'implementing', 'validating', 'delivering', 'delivered'],
  projection: {
    states: { delivering: 'In Review', delivered: 'Done' },
    comments: ['waiting', 'resumed', 'checkpoint'],
  },
  nodes: [
    {
      id: 'dor',
      config: { kind: 'gate', gateSet: { name: DELIVERY_DOR_NAME }, maxRemediationAttempts: 1 },
      onEnter: { setDomainState: 'ready' },
    },
    {
      id: 'plan',
      config: {
        kind: 'agent',
        goal: 'Analyze the work item and repository context. Produce an implementation plan: root cause or approach, files to change, tests to add, and risks.',
        outputSchema: {
          type: 'object',
          properties: {
            approach: { type: 'string' },
            estimated_complexity: { type: 'string', enum: ['small', 'medium', 'large'] },
            security_review_required: { type: 'boolean' },
          },
          required: ['approach'],
        },
      },
      onEnter: { setDomainState: 'planning' },
    },
    {
      id: 'implement',
      config: {
        kind: 'agent',
        goal: 'Implement the planned change completely: code, tests, and any documentation the repository conventions require. Run the relevant validation before declaring completion.',
      },
      onEnter: { setDomainState: 'implementing' },
      retry: { maxAttempts: 2 },
    },
    {
      id: 'test',
      config: { kind: 'command', command: 'npm test', timeoutMs: 15 * 60 * 1000 },
      onEnter: { setDomainState: 'validating' },
    },
    {
      id: 'review',
      config: {
        kind: 'agent',
        goal: 'Independently review the implementation against the goal and acceptance criteria. Inspect the diff and tests.',
        outputSchema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'string' } },
          },
          required: ['approved'],
        },
      },
    },
    {
      id: 'remediate',
      config: {
        kind: 'agent',
        goal: 'Address every legitimate finding from the review. Re-run the tests before declaring completion.',
      },
    },
    {
      id: 're_test',
      config: { kind: 'command', command: 'npm test', timeoutMs: 15 * 60 * 1000 },
    },
    {
      id: 're_review',
      config: {
        kind: 'agent',
        goal: 'Re-review the remediated implementation. Confirm the earlier findings are resolved.',
        outputSchema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'string' } },
          },
          required: ['approved'],
        },
      },
    },
    {
      id: 'dod',
      config: { kind: 'gate', gateSet: { name: DELIVERY_DOD_NAME } },
    },
    {
      id: 'commit',
      config: {
        kind: 'action',
        action: 'source_control.commit',
        with: { message: 'feat: implement the requested change' },
      },
      onEnter: { setDomainState: 'delivering' },
    },
    {
      id: 'deliver',
      config: { kind: 'action', action: 'source_control.pull_request', with: {} },
    },
    {
      id: 'update_item',
      config: {
        kind: 'action',
        action: 'work.comment',
        with: { body: 'Implementation delivered as a pull request by Overture.' },
      },
    },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
    { id: 'failed', config: { kind: 'terminal', outcome: 'failed' } },
  ],
  transitions: [
    { id: 'dor-ok', from: 'dor', to: 'plan', condition: "node.status == 'succeeded'" },
    { id: 'dor-no', from: 'dor', to: 'failed', condition: "node.status == 'failed'" },
    { id: 'plan-impl', from: 'plan', to: 'implement', condition: "node.status == 'succeeded'" },
    { id: 'impl-test', from: 'implement', to: 'test', condition: "node.status == 'succeeded'" },
    { id: 'impl-fail', from: 'implement', to: 'failed', condition: "node.status == 'failed'" },
    { id: 'test-review', from: 'test', to: 'review', condition: "node.status == 'succeeded'" },
    { id: 'test-fail', from: 'test', to: 'failed', condition: "node.status == 'failed'" },
    {
      id: 'review-ok',
      from: 'review',
      to: 'dod',
      condition: 'outputs.approved == true',
    },
    {
      id: 'review-remediate',
      from: 'review',
      to: 'remediate',
      condition: 'outputs.approved == false',
      loopBound: 2,
    },
    {
      id: 'rem-retest',
      from: 'remediate',
      to: 're_test',
      condition: "node.status == 'succeeded'",
      loopBound: 2,
    },
    {
      id: 'retest-rereview',
      from: 're_test',
      to: 're_review',
      condition: "node.status == 'succeeded'",
      loopBound: 2,
    },
    { id: 'retest-fail', from: 're_test', to: 'failed', condition: "node.status == 'failed'" },
    {
      id: 'rereview-ok',
      from: 're_review',
      to: 'dod',
      condition: 'outputs.approved == true',
    },
    {
      id: 'rereview-again',
      from: 're_review',
      to: 'remediate',
      condition: 'outputs.approved == false',
      loopBound: 1,
    },
    { id: 'dod-ok', from: 'dod', to: 'commit', condition: "node.status == 'succeeded'" },
    { id: 'dod-no', from: 'dod', to: 'failed', condition: "node.status == 'failed'" },
    {
      id: 'commit-deliver',
      from: 'commit',
      to: 'deliver',
      condition: "node.status == 'succeeded'",
    },
    {
      id: 'deliver-update',
      from: 'deliver',
      to: 'update_item',
      condition: "node.status == 'succeeded'",
      effects: { setDomainState: 'delivered', project: 'In Review' },
    },
    { id: 'update-done', from: 'update_item', to: 'done', condition: "node.status == 'succeeded'" },
  ],
}
