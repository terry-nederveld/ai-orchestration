/**
 * Runtime protocol tools: the explicit-completion contract between the loop
 * and the model. Completion is never inferred from plain text.
 */

import type { ToolDescriptor } from '@overture/core'

export const COMPLETE_GOAL_TOOL = 'complete_goal'
export const REQUEST_HUMAN_INPUT_TOOL = 'request_human_input'
export const RUN_SUBAGENT_TOOL = 'run_subagent'

export const completeGoalDescriptor: ToolDescriptor = {
  name: COMPLETE_GOAL_TOOL,
  description:
    'Declare the goal finished. Call with outcome "completed" only when the goal is fully ' +
    'achieved and verified, or "blocked" when it cannot proceed without outside change. ' +
    'The summary is your final report and must stand alone.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['completed', 'blocked'] },
      summary: {
        type: 'string',
        description: 'Complete final report of what was done or why blocked.',
      },
    },
    required: ['outcome', 'summary'],
    additionalProperties: false,
  },
}

export const requestHumanInputDescriptor: ToolDescriptor = {
  name: REQUEST_HUMAN_INPUT_TOOL,
  description:
    'Pause and ask a human for input that only they can provide (credentials, product ' +
    'decisions, irreversible-action approval). Use sparingly.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'What is needed from the human and why.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
}

export const runSubagentDescriptor: ToolDescriptor = {
  name: RUN_SUBAGENT_TOOL,
  description:
    'Delegate an independent, self-contained subtask to a sub-agent and receive its final ' +
    'report. Sub-agents consume budget: delegate only when isolation or parallel expertise ' +
    'clearly outweighs the cost.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Self-contained goal for the sub-agent.' },
      context: { type: 'string', description: 'Everything the sub-agent needs to know.' },
    },
    required: ['goal'],
    additionalProperties: false,
  },
}

export interface CompleteGoalInput {
  readonly outcome: 'completed' | 'blocked'
  readonly summary: string
}

export function parseCompleteGoal(input: unknown): CompleteGoalInput {
  const record = (input ?? {}) as Record<string, unknown>
  const outcome = record.outcome === 'blocked' ? 'blocked' : 'completed'
  const summary = typeof record.summary === 'string' ? record.summary : ''
  return { outcome, summary }
}

export function parseReason(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  return typeof record.reason === 'string' ? record.reason : 'human input requested'
}

/** Standing instructions appended to every native-runtime system prompt. */
export function runtimeInstructions(workspacePath?: string): string {
  const lines = [
    'You are an autonomous agent working toward an explicit goal.',
    'Work step by step using the available tools. Verify your work before declaring it done.',
    `When the goal is fully achieved (or genuinely stuck), call ${COMPLETE_GOAL_TOOL}; ` +
      'plain text never ends the task.',
    `If you need something only a human can provide, call ${REQUEST_HUMAN_INPUT_TOOL}.`,
  ]
  if (workspacePath) lines.push(`Your working directory is: ${workspacePath}`)
  return lines.join('\n')
}
