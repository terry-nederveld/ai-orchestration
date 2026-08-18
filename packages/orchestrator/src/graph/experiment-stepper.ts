/**
 * Binds the resumable ExperimentRunner (@overture/experiments) to the graph
 * runtime's experiment node. All experiment state lives in the persisted
 * ExperimentRecord — the stepper holds nothing in memory between calls, so a
 * judgment can arrive days later on a different process.
 *
 * awaiting-judgment maps to a durable single-choice wait whose choices
 * encode the decision: one `advance:<candidateId>` choice per survivor plus
 * `iterate`, `need-more-evidence`, and `kill`. The satisfying response is
 * decoded into a JudgmentOutcome, persisted to the judgment repository (for
 * judgment observability), and handed to the runner, which resumes from the
 * record alone. A concluded experiment settles the node as succeeded with
 * `conclusion` in its outputs — killed/exhausted are legitimate learnings,
 * not node failures — and the rendered learning markdown rides along so
 * workflows can project it into a work item's managed section.
 */

import type {
  Clock,
  ExperimentRepository,
  IdGenerator,
  JudgmentDecision,
  JudgmentOutcome,
  JudgmentPackage,
  JudgmentRepository,
  Logger,
  RunId,
} from '@overture/core'
import { asId, OrchestratorError } from '@overture/core'
import {
  type ExperimentAgents,
  ExperimentRunner,
  type ExperimentStepInput,
  renderExperimentLearning,
  type StepResult,
} from '@overture/experiments'
import type { NodeYield } from '@overture/workflow'
import type { ExperimentStepper, GraphExecutorDeps } from './node-executors.js'
import {
  createProfileAgentRunner,
  type ProfileAgentRunner,
  parseStructuredOutputs,
} from './node-executors.js'

export const EXPERIMENT_JUDGMENT_REASON = 'EXPERIMENT_JUDGMENT_REQUIRED'

/**
 * ExperimentAgents backed by the run's profile-driven agent execution.
 * Roles run under the workflow's default profile unless a per-role profile
 * is mapped; structured outputs are parsed from the agent's final report.
 */
export function createProfileExperimentAgents(
  runAgent: ProfileAgentRunner,
  roleProfiles: Partial<Record<'generator' | 'evaluator' | 'prototyper', string>> = {},
): ExperimentAgents {
  return {
    async run(goal, context, role) {
      const result = await runAgent(roleProfiles[role], goal, { context, role })
      if (result.outcome !== 'GOAL_COMPLETED') {
        throw new OrchestratorError(
          `experiment ${role} agent did not complete: ${result.outcome}`,
          'provider-outage',
        )
      }
      const outputs = parseStructuredOutputs(result.summary)
      if (!outputs) {
        throw new OrchestratorError(
          `experiment ${role} agent produced no structured outputs`,
          'corrupt-response',
        )
      }
      return { outputs: { ...outputs }, summary: result.summary }
    },
  }
}

/**
 * The shape GraphCoordinatorOptions.experiments expects: given the run's
 * executor deps, produce a stepper whose agent phases run through that
 * run's profile resolution and fallback chain.
 */
export function profileExperimentStepperFactory(
  stores: { readonly experiments: ExperimentRepository; readonly judgments: JudgmentRepository },
  roleProfiles?: Partial<Record<'generator' | 'evaluator' | 'prototyper', string>>,
): (deps: GraphExecutorDeps) => ExperimentStepper {
  return (deps) =>
    createExperimentStepper({
      agents: createProfileExperimentAgents(createProfileAgentRunner(deps), roleProfiles ?? {}),
      experiments: stores.experiments,
      judgments: stores.judgments,
      ids: deps.ids,
      clock: deps.clock,
      logger: deps.logger,
    })
}

export interface ExperimentStepperOptions {
  readonly agents: ExperimentAgents
  readonly experiments: ExperimentRepository
  readonly judgments: JudgmentRepository
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly logger: Logger
}

export function createExperimentStepper(options: ExperimentStepperOptions): ExperimentStepper {
  const runner = new ExperimentRunner({
    agents: options.agents,
    experiments: options.experiments,
    clock: options.clock,
    ids: options.ids,
    logger: options.logger,
  })

  return {
    async step(input) {
      const runId = asId<'run'>(input.runId) as RunId
      const record = (await options.experiments.listForRun(runId)).find(
        (candidate) => candidate.nodeId === input.nodeId,
      )

      let judgment: JudgmentOutcome | undefined
      if (input.satisfaction?.input && record) {
        judgment = decodeJudgment(record.id, input.satisfaction.input)
        await options.judgments.save(judgment)
      }

      const base: Omit<ExperimentStepInput, 'record' | 'judgment'> = {
        definition: input.definition,
        rubric: input.rubric,
        hypothesis: input.hypothesis,
        runId,
        nodeId: input.nodeId,
      }
      let result: StepResult = await runner.step({
        ...base,
        ...(record ? { record } : {}),
        ...(judgment ? { judgment } : {}),
      })
      while (result.type === 'continue') {
        result = await runner.step({ ...base, record: result.record })
      }
      return toNodeYield(result)
    },
  }
}

function toNodeYield(result: Exclude<StepResult, { type: 'continue' }>): NodeYield {
  if (result.type === 'awaiting-judgment') {
    return {
      type: 'wait',
      spec: {
        kind: 'human-input',
        parameters: {
          reason: EXPERIMENT_JUDGMENT_REASON,
          experimentId: result.record.id,
          nodeId: result.record.nodeId,
          judgment: result.package as unknown as Record<string, unknown>,
        },
      },
      request: {
        type: 'single-choice',
        prompt: renderJudgmentPrompt(result.package),
        surface: 'both',
        choices: judgmentChoices(result.package),
      },
    }
  }

  const selected = result.selected
  return {
    type: 'result',
    status: 'succeeded',
    outputs: {
      conclusion: result.conclusion,
      experimentId: result.record.id,
      iterations: result.record.iteration,
      learning: renderExperimentLearning(result.record),
      ...(selected
        ? {
            selected: {
              candidateId: selected.id,
              title: selected.title,
              summary: selected.summary,
              weightedScore: selected.weightedScore ?? 0,
              artifacts: selected.artifacts,
            },
          }
        : {}),
    },
  }
}

export function judgmentChoices(judgmentPackage: JudgmentPackage): readonly string[] {
  return [
    ...judgmentPackage.survivors.map((survivor) => `advance:${survivor.candidateId}`),
    'iterate',
    'need-more-evidence',
    'kill',
  ]
}

/** Decode a single-choice response back into a JudgmentOutcome. */
export function decodeJudgment(
  experimentId: string,
  input: { readonly value: unknown; readonly responder: string; readonly at: Date },
): JudgmentOutcome {
  const value = typeof input.value === 'string' ? input.value : ''
  if (value.startsWith('advance:')) {
    const selectedCandidateId = value.slice('advance:'.length)
    if (!selectedCandidateId) {
      throw new OrchestratorError('advance judgment names no candidate', 'invalid-input')
    }
    return {
      experimentId,
      decision: 'advance',
      selectedCandidateId,
      decidedBy: input.responder,
      at: input.at,
    }
  }
  if (value === 'kill' || value === 'iterate' || value === 'need-more-evidence') {
    return {
      experimentId,
      decision: value as JudgmentDecision,
      decidedBy: input.responder,
      at: input.at,
    }
  }
  throw new OrchestratorError(`unrecognized judgment choice '${value}'`, 'invalid-input')
}

function renderJudgmentPrompt(judgmentPackage: JudgmentPackage): string {
  const lines = [
    `Experiment judgment required (iteration ${judgmentPackage.iteration} of ${judgmentPackage.maxIterations}).`,
    '',
    `Hypothesis: ${judgmentPackage.hypothesis}`,
    `Rubric: ${judgmentPackage.rubricSummary}`,
    '',
    'Survivors:',
    ...judgmentPackage.survivors.map(
      (survivor) =>
        `- ${survivor.title} (score ${survivor.weightedScore.toFixed(2)}, id ${survivor.candidateId}): ${survivor.summary}`,
    ),
    '',
    `Recommendation: ${judgmentPackage.recommendation}`,
  ]
  if (judgmentPackage.risks.length > 0) {
    lines.push('', 'Risks:', ...judgmentPackage.risks.map((risk) => `- ${risk}`))
  }
  lines.push(
    '',
    'Choices: advance:<candidateId> advances that candidate; iterate runs another bounded iteration; need-more-evidence gathers more evidence on the survivors; kill concludes the experiment.',
  )
  return lines.join('\n')
}
