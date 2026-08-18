/**
 * Flagship B — Autonomous Discovery (mission §Flagship B, §35).
 *
 * Outcome/problem → evidence investigation → pain points → hypothesis →
 * experiment (candidates, prototypes, pinned rubric, kill/advance, human
 * judgment, bounded iteration) → PRD captured into the work item's managed
 * section → configurable approval → related stories created → stop or
 * hand off to Autonomous Delivery.
 *
 * Configuration points (variables): `stop_after` = 'prd' stops before
 * story creation; the approval node may be removed by forking the
 * template. Discovery remains useful without Delivery.
 */

import type { WorkflowGraph } from '@overture/core'

export const DISCOVERY_WORKFLOW_NAME = 'autonomous-discovery'
export const DISCOVERY_STORY_WORKFLOW_NAME = 'discovery-create-story'
export const DISCOVERY_EXPERIMENT_NAME = 'discovery-experiment'
export const DISCOVERY_RUBRIC_NAME = 'discovery-rubric'

/** Child workflow: create one story from a fan-out item. */
export const discoveryCreateStoryWorkflow: WorkflowGraph = {
  name: DISCOVERY_STORY_WORKFLOW_NAME,
  description: 'Creates a single related story from a discovery outcome.',
  entry: 'create',
  nodes: [
    {
      id: 'create',
      config: {
        kind: 'action',
        action: 'work.create_item',
        with: {
          title: '$expr:vars.item.title',
          description: '$expr:vars.item.description',
          type: 'story',
          labels: ['agent-ready'],
        },
      },
    },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
  ],
  transitions: [{ id: 'c-d', from: 'create', to: 'done', condition: "node.status == 'succeeded'" }],
}

export const discoveryWorkflow: WorkflowGraph = {
  name: DISCOVERY_WORKFLOW_NAME,
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
        experiment: { name: DISCOVERY_EXPERIMENT_NAME },
        rubric: { name: DISCOVERY_RUBRIC_NAME },
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
        workflow: { name: DISCOVERY_STORY_WORKFLOW_NAME },
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
    {
      id: 'exp-prd',
      from: 'experiment',
      to: 'prd',
      condition: "outputs.conclusion == 'advanced'",
    },
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
    {
      id: 'approved',
      from: 'approval',
      to: 'create_stories',
      condition: 'outputs.value == true',
    },
    {
      id: 'declined',
      from: 'approval',
      to: 'done_prd',
      condition: 'outputs.value == false',
    },
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
