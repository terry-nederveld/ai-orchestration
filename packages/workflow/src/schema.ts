/**
 * Zod schema for the declarative workflow YAML format. This is the "raw"
 * (snake_case, author-facing) shape; parser.ts converts a validated raw
 * document into the stable `@overture/core` `WorkflowDefinition` contract.
 *
 * All structural validation lives here, in a single pass, so a document with
 * multiple problems reports every one of them (via `.superRefine`) rather
 * than failing fast on the first.
 */

import { z } from 'zod'
import { parseDurationMs } from './duration.js'
import { DURATION_REGEX } from './duration-regex.js'
import { parseExpression } from './expressions.js'

const durationSchema = z
  .string()
  .regex(DURATION_REGEX, 'must be a duration like 30s, 10m, 2h, or 500ms')
  .transform((value) => parseDurationMs(value))

const retrySchema = z
  .object({
    max_attempts: z.number().int().min(1),
    backoff: durationSchema.optional(),
  })
  .strict()

const triggerSchema = z
  .object({
    states: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
  })
  .strict()

const eligibilitySchema = z
  .object({
    labels: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    types: z.array(z.string()).optional(),
    assignee: z.string().optional(),
  })
  .strict()

const workspaceSchema = z
  .object({
    strategy: z.string().min(1),
    retention: z.enum(['always', 'on-failure', 'never']).optional(),
  })
  .strict()

const transitionsSchema = z
  .object({
    success: z.string().optional(),
    failure: z.string().optional(),
    blocked: z.string().optional(),
  })
  .strict()

const STEP_KIND_FIELDS = ['agent', 'command', 'action', 'approval'] as const

const stepSchema = z
  .object({
    id: z.string().min(1),
    // agent
    agent: z.string().optional(),
    goal: z.string().optional(),
    route: z.string().optional(),
    tool_names: z.array(z.string()).optional(),
    max_turns: z.number().int().positive().optional(),
    // command
    command: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    // action
    action: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    // approval
    approval: z.string().optional(),
    // common
    depends_on: z.array(z.string()).optional(),
    when: z.string().optional(),
    timeout: durationSchema.optional(),
    retry: retrySchema.optional(),
    continue_on_failure: z.boolean().optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const present = STEP_KIND_FIELDS.filter((field) => step[field] !== undefined)
    if (present.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `step must declare exactly one of: ${STEP_KIND_FIELDS.join(', ')}`,
      })
    } else if (present.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `step declares multiple kinds (${present.join(', ')}); exactly one is required`,
      })
    }
    if (step.agent !== undefined && (step.goal === undefined || step.goal.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['goal'],
        message: 'agent steps require a non-empty goal',
      })
    }
    if (step.when !== undefined) {
      try {
        parseExpression(step.when)
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['when'],
          message: `invalid when expression: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  })

export type RawStep = z.infer<typeof stepSchema>

/** Finds a dependency cycle, if any, restricted to edges between known step ids. */
function findCycle(steps: readonly RawStep[]): string[] | undefined {
  const ids = new Set(steps.map((step) => step.id))
  const adjacency = new Map<string, string[]>(
    steps.map((step) => [step.id, (step.depends_on ?? []).filter((dep) => ids.has(dep))]),
  )
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  function visit(id: string): string[] | undefined {
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of adjacency.get(id) ?? []) {
      if (state.get(dep) === 'visiting') {
        const start = stack.indexOf(dep)
        return [...stack.slice(start), dep]
      }
      if (state.get(dep) !== 'done') {
        const found = visit(dep)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }

  for (const id of ids) {
    if (state.get(id) === undefined) {
      const found = visit(id)
      if (found) return found
    }
  }
  return undefined
}

export const rawWorkflowSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: triggerSchema.optional(),
    eligibility: eligibilitySchema.optional(),
    workspace: workspaceSchema.optional(),
    variables: z.record(z.string(), z.string()).optional(),
    budget: z.string().optional(),
    steps: z.array(stepSchema).min(1),
    transitions: transitionsSchema.optional(),
  })
  .strict()
  .superRefine((workflow, ctx) => {
    const firstSeenAt = new Map<string, number>()
    workflow.steps.forEach((step, index) => {
      const seenAt = firstSeenAt.get(step.id)
      if (seenAt !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate step id '${step.id}' (also declared at steps[${seenAt}])`,
        })
      } else {
        firstSeenAt.set(step.id, index)
      }
    })

    const knownIds = new Set(workflow.steps.map((step) => step.id))
    workflow.steps.forEach((step, index) => {
      ;(step.depends_on ?? []).forEach((dep, depIndex) => {
        if (!knownIds.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'depends_on', depIndex],
            message: `depends_on references unknown step '${dep}'`,
          })
        }
      })
    })

    const cycle = findCycle(workflow.steps)
    if (cycle) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `dependency cycle detected: ${cycle.join(' -> ')}`,
      })
    }
  })

export type RawWorkflow = z.infer<typeof rawWorkflowSchema>

/** JSON Schema for the workflow YAML format, for editor tooling (autocomplete, validation). */
export const workflowJsonSchema = z.toJSONSchema(rawWorkflowSchema, { io: 'input' })
