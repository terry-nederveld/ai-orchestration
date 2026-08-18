/**
 * Test fixtures: the two flagship template graphs, mirrored from
 * `packages/templates/src/delivery.ts` and `discovery.ts` (the UI package
 * does not depend on workspace packages, so the documents are copied).
 * The designer must render both without dropping any construct.
 */

import type { WorkflowGraphDoc } from './types'

export const deliveryFixture: WorkflowGraphDoc = {
  name: 'autonomous-delivery',
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
      config: {
        kind: 'gate',
        gateSet: { name: 'delivery-definition-of-ready' },
        maxRemediationAttempts: 1,
      },
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
      config: { kind: 'command', command: 'npm test', timeoutMs: 900000 },
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
      config: { kind: 'command', command: 'npm test', timeoutMs: 900000 },
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
      config: { kind: 'gate', gateSet: { name: 'delivery-definition-of-done' } },
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
    { id: 'review-ok', from: 'review', to: 'dod', condition: 'outputs.approved == true' },
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
    { id: 'rereview-ok', from: 're_review', to: 'dod', condition: 'outputs.approved == true' },
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

export const discoveryFixture: WorkflowGraphDoc = {
  name: 'autonomous-discovery',
  description:
    'Outcome-driven discovery: investigate evidence, form a hypothesis, run a rubric-judged experiment with human kill/advance judgment, capture a PRD in the work item, and — after configurable approval — create agent-ready stories.',
  entry: 'investigate',
  defaultProfile: { name: 'discovery-default' },
  domainStates: [
    'investigating',
    'hypothesizing',
    'experimenting',
    'drafting-prd',
    'awaiting-approval',
    'creating-stories',
    'concluded-killed',
    'concluded-advanced',
  ],
  projection: {
    managedSection: true,
    comments: ['waiting', 'resumed', 'checkpoint'],
  },
  nodes: [
    {
      id: 'investigate',
      config: {
        kind: 'agent',
        goal: 'Investigate the stated outcome or problem using the permitted context and tools. Identify concrete pain points with provenance (where each was observed).',
        outputSchema: {
          type: 'object',
          properties: {
            pain_points: {
              type: 'array',
              items: {
                type: 'object',
                properties: { description: { type: 'string' }, provenance: { type: 'string' } },
              },
            },
            evidence_summary: { type: 'string' },
          },
          required: ['pain_points', 'evidence_summary'],
        },
      },
      onEnter: { setDomainState: 'investigating' },
    },
    {
      id: 'hypothesize',
      config: {
        kind: 'agent',
        goal: 'From the pain points, form the single most promising testable hypothesis for improving the outcome. State what evidence would kill it.',
        outputSchema: {
          type: 'object',
          properties: {
            hypothesis: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['hypothesis'],
        },
      },
      onEnter: { setDomainState: 'hypothesizing' },
      onExit: { setData: { hypothesis: 'outputs.hypothesis' } },
    },
    {
      id: 'experiment',
      config: {
        kind: 'experiment',
        experiment: { name: 'discovery-experiment' },
        rubric: { name: 'discovery-rubric' },
      },
      onEnter: { setDomainState: 'experimenting' },
    },
    {
      id: 'prd',
      config: {
        kind: 'agent',
        goal: 'Write a complete PRD for the surviving approach: problem, evidence, selected approach with experiment learnings, requirements, non-goals, risks, and success metrics.',
        outputSchema: {
          type: 'object',
          properties: {
            prd_markdown: { type: 'string' },
            story_candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, description: { type: 'string' } },
              },
            },
          },
          required: ['prd_markdown', 'story_candidates'],
        },
      },
      onEnter: { setDomainState: 'drafting-prd' },
    },
    {
      id: 'capture_prd',
      config: {
        kind: 'action',
        action: 'work.update_section',
        with: { content: '$expr:results.prd.outputs.prd_markdown' },
      },
    },
    {
      id: 'approval',
      config: {
        kind: 'human-input',
        request: {
          type: 'approval',
          prompt:
            'The discovery PRD is captured on the work item. Approve creation of the related stories?',
          surface: 'both',
        },
      },
      onEnter: { setDomainState: 'awaiting-approval' },
    },
    {
      id: 'create_stories',
      config: {
        kind: 'fan-out',
        items: 'results.prd.outputs.story_candidates',
        workflow: { name: 'discovery-create-story' },
        join: { mode: 'all' },
      },
      onEnter: { setDomainState: 'creating-stories' },
    },
    { id: 'done_prd', config: { kind: 'terminal', outcome: 'completed' } },
    { id: 'done_stories', config: { kind: 'terminal', outcome: 'completed' } },
    { id: 'killed', config: { kind: 'terminal', outcome: 'completed' } },
    { id: 'failed', config: { kind: 'terminal', outcome: 'failed' } },
  ],
  transitions: [
    {
      id: 'inv-hyp',
      from: 'investigate',
      to: 'hypothesize',
      condition: "node.status == 'succeeded'",
    },
    {
      id: 'hyp-exp',
      from: 'hypothesize',
      to: 'experiment',
      condition: "node.status == 'succeeded'",
    },
    { id: 'exp-prd', from: 'experiment', to: 'prd', condition: "outputs.conclusion == 'advanced'" },
    {
      id: 'exp-killed',
      from: 'experiment',
      to: 'killed',
      condition: "outputs.conclusion == 'killed' || outputs.conclusion == 'exhausted'",
      effects: { setDomainState: 'concluded-killed' },
    },
    { id: 'prd-capture', from: 'prd', to: 'capture_prd', condition: "node.status == 'succeeded'" },
    {
      id: 'capture-stop',
      from: 'capture_prd',
      to: 'done_prd',
      condition: "vars.stop_after == 'prd'",
    },
    {
      id: 'capture-approval',
      from: 'capture_prd',
      to: 'approval',
      condition: "vars.stop_after != 'prd'",
    },
    { id: 'approved', from: 'approval', to: 'create_stories', condition: 'outputs.value == true' },
    { id: 'declined', from: 'approval', to: 'done_prd', condition: 'outputs.value == false' },
    {
      id: 'stories-done',
      from: 'create_stories',
      to: 'done_stories',
      condition: "node.status == 'succeeded'",
      effects: { setDomainState: 'concluded-advanced' },
    },
    {
      id: 'stories-failed',
      from: 'create_stories',
      to: 'failed',
      condition: "node.status == 'failed'",
    },
  ],
}
