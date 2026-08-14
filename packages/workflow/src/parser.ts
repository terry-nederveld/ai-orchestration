/**
 * Parses and validates a workflow YAML document into the stable
 * `@overture/core` `WorkflowDefinition` contract.
 */

import type {
  ActionStep,
  AgentStep,
  ApprovalStep,
  CommandStep,
  RetryPolicy,
  WorkflowDefinition,
  WorkflowEligibility,
  WorkflowStep,
  WorkflowTransitions,
  WorkflowTrigger,
  WorkflowWorkspaceConfig,
} from '@overture/core'
import { parse as parseYamlDocument } from 'yaml'
import { WorkflowValidationError } from './errors.js'
import { type RawStep, type RawWorkflow, rawWorkflowSchema } from './schema.js'

function formatPath(path: readonly (string | number | symbol)[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      const key = String(segment)
      out += out ? `.${key}` : key
    }
  }
  return out || '(root)'
}

/** Parses YAML text into a validated `WorkflowDefinition`. Throws {@link WorkflowValidationError} listing every problem found. */
export function parseWorkflowYaml(source: string, documentName = '(root)'): WorkflowDefinition {
  let raw: unknown
  try {
    raw = parseYamlDocument(source)
  } catch (error) {
    throw new WorkflowValidationError([
      {
        path: documentName,
        message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      },
    ])
  }

  const result = rawWorkflowSchema.safeParse(raw)
  if (!result.success) {
    throw new WorkflowValidationError(
      result.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    )
  }
  return toWorkflowDefinition(result.data)
}

function toWorkflowDefinition(raw: RawWorkflow): WorkflowDefinition {
  return {
    name: raw.name,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.trigger !== undefined ? { trigger: toTrigger(raw.trigger) } : {}),
    ...(raw.eligibility !== undefined ? { eligibility: toEligibility(raw.eligibility) } : {}),
    ...(raw.workspace !== undefined ? { workspace: toWorkspace(raw.workspace) } : {}),
    ...(raw.variables !== undefined ? { variables: raw.variables } : {}),
    ...(raw.budget !== undefined ? { budget: raw.budget } : {}),
    steps: raw.steps.map(toStep),
    ...(raw.transitions !== undefined ? { transitions: toTransitions(raw.transitions) } : {}),
  }
}

function toTrigger(raw: NonNullable<RawWorkflow['trigger']>): WorkflowTrigger {
  return {
    ...(raw.states !== undefined ? { states: raw.states } : {}),
    ...(raw.labels !== undefined ? { labels: raw.labels } : {}),
  }
}

function toTransitions(raw: NonNullable<RawWorkflow['transitions']>): WorkflowTransitions {
  return {
    ...(raw.success !== undefined ? { success: raw.success } : {}),
    ...(raw.failure !== undefined ? { failure: raw.failure } : {}),
    ...(raw.blocked !== undefined ? { blocked: raw.blocked } : {}),
  }
}

function toWorkspace(raw: NonNullable<RawWorkflow['workspace']>): WorkflowWorkspaceConfig {
  return {
    strategy: raw.strategy,
    ...(raw.retention !== undefined ? { retention: raw.retention } : {}),
  }
}

function toEligibility(raw: NonNullable<RawWorkflow['eligibility']>): WorkflowEligibility {
  return {
    ...(raw.labels?.include !== undefined ? { labelsInclude: raw.labels.include } : {}),
    ...(raw.labels?.exclude !== undefined ? { labelsExclude: raw.labels.exclude } : {}),
    ...(raw.types !== undefined ? { types: raw.types } : {}),
    ...(raw.assignee !== undefined ? { assignee: raw.assignee } : {}),
  }
}

function toRetry(raw: NonNullable<RawStep['retry']>): RetryPolicy {
  return {
    maxAttempts: raw.max_attempts,
    ...(raw.backoff !== undefined ? { backoffMs: raw.backoff } : {}),
  }
}

function toStep(step: RawStep): WorkflowStep {
  const base = {
    id: step.id,
    ...(step.depends_on !== undefined ? { dependsOn: step.depends_on } : {}),
    ...(step.when !== undefined ? { when: step.when } : {}),
    ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    ...(step.retry !== undefined ? { retry: toRetry(step.retry) } : {}),
    ...(step.continue_on_failure !== undefined
      ? { continueOnFailure: step.continue_on_failure }
      : {}),
  }

  if (step.agent !== undefined) {
    const agentStep: AgentStep = {
      ...base,
      kind: 'agent',
      agent: step.agent,
      // schema guarantees goal is present and non-empty when agent is set
      goal: step.goal as string,
      ...(step.route !== undefined ? { route: step.route } : {}),
      ...(step.tool_names !== undefined ? { toolNames: step.tool_names } : {}),
      ...(step.max_turns !== undefined ? { maxTurns: step.max_turns } : {}),
    }
    return agentStep
  }

  if (step.command !== undefined) {
    const commandStep: CommandStep = {
      ...base,
      kind: 'command',
      command: step.command,
      ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
      ...(step.env !== undefined ? { env: step.env } : {}),
    }
    return commandStep
  }

  if (step.action !== undefined) {
    const actionStep: ActionStep = {
      ...base,
      kind: 'action',
      action: step.action,
      ...(step.with !== undefined ? { with: step.with } : {}),
    }
    return actionStep
  }

  // schema guarantees exactly one of agent/command/action/approval is set
  const approvalStep: ApprovalStep = {
    ...base,
    kind: 'approval',
    description: step.approval as string,
  }
  return approvalStep
}
