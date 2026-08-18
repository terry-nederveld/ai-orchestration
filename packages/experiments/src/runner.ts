/**
 * Resumable experiment state machine (mission §13–§15, ADR-0017 tick model).
 *
 * `step` is a reducer over the persisted ExperimentRecord: each call derives
 * the current phase from record state alone (status, iteration, candidate
 * statuses of the current iteration), executes exactly one phase, persists
 * through the repository, and returns. The caller — a graph-node executor —
 * invokes `step` repeatedly; an `awaiting-judgment` result maps onto a
 * durable wait (ADR-0019) and a later call carrying the JudgmentOutcome
 * resumes the machine. The runner holds no in-memory state between calls, so
 * it survives process restarts and JSON round-trips of the record.
 *
 * Phase order per iteration:
 *   generate → prototype (when definition.prototype) → evaluate →
 *   select → awaiting-judgment → (advance | kill | iterate | more evidence)
 *
 * Kill-criteria expressions are evaluated with the workflow scope-expression
 * language against a documented scope:
 *
 *   candidate.id / candidate.title / candidate.iteration
 *   candidate.scores.<criterionId>   — numeric score per rubric criterion
 *   candidate.weightedScore          — core weightedScore over the rubric
 *   candidate.evidenceCount          — number of evidence entries
 *   candidate.artifactCount          — number of prototype artifacts
 *   outputs.<key>                    — raw evaluator outputs for the candidate
 *
 * The language supports ==, !=, !, &&, || and truthiness; kill expressions
 * needing ordered comparisons should have the evaluator emit boolean output
 * keys (e.g. `outputs.latencyBudgetExceeded`) instead. Kill criteria without
 * an expression are placed in the evaluator prompt verbatim and honored via
 * `outputs.kills` entries whose criterionId matches the rubric.
 *
 * Evaluator `risks` outputs are persisted as candidate evidence entries with
 * a `risk: ` prefix (the record schema has no risk field) and are stripped
 * back out when building the JudgmentPackage.
 */

import type {
  Candidate,
  Clock,
  CriterionScore,
  EvaluationRubric,
  ExperimentDefinition,
  ExperimentRecord,
  ExperimentRepository,
  IdGenerator,
  JudgmentOutcome,
  JudgmentPackage,
  Logger,
  RunId,
} from '@overture/core'
import { OrchestratorError, systemClock, weightedScore } from '@overture/core'
import { evaluateScopeExpression } from '@overture/workflow'

export type ExperimentAgentRole = 'generator' | 'evaluator' | 'prototyper'

/** Minimal agent port; the orchestrator binds this to real agent profiles. */
export interface ExperimentAgents {
  run(
    goal: string,
    context: string,
    role: ExperimentAgentRole,
  ): Promise<{ outputs: Record<string, unknown>; summary: string }>
}

export interface ExperimentRunnerDeps {
  readonly agents: ExperimentAgents
  readonly experiments: ExperimentRepository
  readonly clock?: Clock
  readonly ids: IdGenerator
  readonly logger: Logger
}

export interface ExperimentStepInput {
  readonly record?: ExperimentRecord
  readonly definition: ExperimentDefinition & { readonly version: number }
  readonly rubric: EvaluationRubric & { readonly version: number }
  readonly hypothesis: string
  readonly runId: RunId
  readonly nodeId: string
  readonly judgment?: JudgmentOutcome
}

export type StepResult =
  | { readonly type: 'continue'; readonly record: ExperimentRecord }
  | {
      readonly type: 'awaiting-judgment'
      readonly record: ExperimentRecord
      readonly package: JudgmentPackage
    }
  | {
      readonly type: 'concluded'
      readonly record: ExperimentRecord
      readonly conclusion: 'advanced' | 'killed' | 'exhausted'
      readonly selected?: Candidate
    }

const RISK_PREFIX = 'risk: '

const evidencePassLesson = (iteration: number) =>
  `additional evidence gathered for iteration ${iteration}`

export class ExperimentRunner {
  private readonly clock: Clock

  constructor(private readonly deps: ExperimentRunnerDeps) {
    this.clock = deps.clock ?? systemClock
  }

  async step(input: ExperimentStepInput): Promise<StepResult> {
    const record = input.record ? reviveRecord(input.record) : undefined

    if (!record) {
      return this.generate(this.createRecord(input), input)
    }
    if (record.status === 'concluded') {
      return this.concludedResult(record)
    }
    if (record.status === 'awaiting-judgment') {
      if (input.judgment) return this.applyJudgment(record, input, input.judgment)
      return { type: 'awaiting-judgment', record, package: this.buildPackage(record, input) }
    }

    // status 'running': enforce wall clock, then run the phase the record is in.
    const limitMs = input.definition.maxWallClockMs
    if (limitMs !== undefined) {
      const elapsed = this.clock.now().getTime() - record.createdAt.getTime()
      if (elapsed >= limitMs) {
        const concluded = await this.conclude(record, 'exhausted', [
          `wall clock budget exhausted after ${elapsed}ms (limit ${limitMs}ms) in iteration ${record.iteration}`,
        ])
        return this.concludedResult(concluded)
      }
    }

    const current = candidatesOf(record, record.iteration)
    if (current.length === 0) return this.generate(record, input)

    const generated = current.filter((candidate) => candidate.status === 'generated')
    if (generated.length > 0) {
      if (input.definition.prototype) return this.prototype(record, input, generated)
      return this.evaluate(record, input, generated)
    }

    const prototyped = current.filter((candidate) => candidate.status === 'prototyped')
    if (prototyped.length > 0) return this.evaluate(record, input, prototyped)

    return this.select(record, input)
  }

  // -------------------------------------------------------------------------
  // Phase 1: generate
  // -------------------------------------------------------------------------

  private async generate(
    record: ExperimentRecord,
    input: ExperimentStepInput,
  ): Promise<StepResult> {
    const { definition, hypothesis } = input
    const goal = [
      `Generate up to ${definition.candidateCount} distinct candidate approaches for an experiment.`,
      `Hypothesis: ${hypothesis}`,
      definition.generationStrategy ? `Generation strategy: ${definition.generationStrategy}` : '',
      'Respond with outputs of the shape { "candidates": [{ "title": string, "summary": string }] }.',
    ]
      .filter((line) => line !== '')
      .join('\n')
    const context = [
      definition.description
        ? `Experiment: ${definition.name} — ${definition.description}`
        : `Experiment: ${definition.name}`,
      `Iteration ${record.iteration} of ${definition.maxIterations}.`,
      record.lessons.length > 0
        ? `Lessons from prior work:\n${record.lessons.map((lesson) => `- ${lesson}`).join('\n')}`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n')

    const { outputs } = await this.deps.agents.run(goal, context, 'generator')
    const raw = (outputs as { candidates?: unknown }).candidates
    if (!Array.isArray(raw)) {
      throw new OrchestratorError(
        `generator returned no candidates array for experiment '${record.id}'`,
        'corrupt-response',
      )
    }
    const candidates: Candidate[] = raw.slice(0, definition.candidateCount).map((entry) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { title?: unknown }).title !== 'string' ||
        typeof (entry as { summary?: unknown }).summary !== 'string'
      ) {
        throw new OrchestratorError(
          `generator returned a malformed candidate for experiment '${record.id}'`,
          'corrupt-response',
        )
      }
      const shaped = entry as { title: string; summary: string }
      return {
        id: this.deps.ids.next('candidate'),
        iteration: record.iteration,
        title: shaped.title,
        summary: shaped.summary,
        status: 'generated',
        artifacts: {},
        evidence: [],
        scores: [],
      }
    })
    if (candidates.length === 0) {
      throw new OrchestratorError(
        `generator returned zero candidates for experiment '${record.id}'`,
        'corrupt-response',
      )
    }

    this.deps.logger.info('experiment candidates generated', {
      experimentId: record.id,
      iteration: record.iteration,
      count: candidates.length,
    })
    const next = await this.persist({
      ...record,
      candidates: [...record.candidates, ...candidates],
    })
    return { type: 'continue', record: next }
  }

  // -------------------------------------------------------------------------
  // Phase 2: prototype
  // -------------------------------------------------------------------------

  private async prototype(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    pending: readonly Candidate[],
  ): Promise<StepResult> {
    const updates = new Map<string, Candidate>()
    const lessons: string[] = []
    for (const candidate of pending) {
      const goal = [
        `Build and exercise a prototype for candidate "${candidate.title}".`,
        `Candidate summary: ${candidate.summary}`,
        `Hypothesis under test: ${input.hypothesis}`,
        'Respond with outputs of the shape { "artifacts"?: { [name]: string }, "evidence"?: string[] }.',
      ].join('\n')
      try {
        const { outputs } = await this.deps.agents.run(
          goal,
          `Experiment: ${input.definition.name}`,
          'prototyper',
        )
        updates.set(candidate.id, {
          ...candidate,
          status: 'prototyped',
          artifacts: { ...candidate.artifacts, ...stringRecord(outputs.artifacts) },
          evidence: [...candidate.evidence, ...stringArray(outputs.evidence)],
        })
      } catch (error) {
        // A failed prototype kills the candidate, never the experiment.
        const reason = error instanceof Error ? error.message : String(error)
        updates.set(candidate.id, {
          ...candidate,
          status: 'killed',
          killedBy: 'prototype-failure',
          killReason: reason,
        })
        lessons.push(
          `iteration ${record.iteration}: prototype failed for "${candidate.title}": ${reason}`,
        )
      }
    }
    const next = await this.persist({
      ...record,
      candidates: record.candidates.map((candidate) => updates.get(candidate.id) ?? candidate),
      lessons: [...record.lessons, ...lessons],
    })
    return { type: 'continue', record: next }
  }

  // -------------------------------------------------------------------------
  // Phase 3: evaluate
  // -------------------------------------------------------------------------

  private async evaluate(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    pending: readonly Candidate[],
  ): Promise<StepResult> {
    const updates = new Map<string, Candidate>()
    const lessons: string[] = []
    for (const candidate of pending) {
      const { outputs } = await this.deps.agents.run(
        this.evaluatorGoal(input),
        this.evaluatorContext(candidate),
        'evaluator',
      )
      const evaluated = this.applyEvaluation(record, input, candidate, outputs)
      updates.set(candidate.id, evaluated)
      if (evaluated.status === 'killed') {
        lessons.push(
          `iteration ${record.iteration}: candidate "${evaluated.title}" killed by ${evaluated.killedBy}: ${evaluated.killReason}`,
        )
      }
    }
    const next = await this.persist({
      ...record,
      candidates: record.candidates.map((candidate) => updates.get(candidate.id) ?? candidate),
      lessons: [...record.lessons, ...lessons],
    })
    return { type: 'continue', record: next }
  }

  /**
   * Rubric criteria are pinned (ADR-0018): the goal instructs the evaluator
   * to score the criteria verbatim, never to rewrite them.
   */
  private evaluatorGoal(input: ExperimentStepInput, extraContext?: string): string {
    const { rubric } = input
    const criteria = rubric.criteria
      .map(
        (criterion) => `- ${criterion.id} (weight ${criterion.weight}): ${criterion.description}`,
      )
      .join('\n')
    const promptKills = rubric.killCriteria.filter(
      (criterion) => criterion.expression === undefined,
    )
    const lines = [
      `Evaluate the candidate against the pinned rubric "${rubric.name}" (version ${input.rubric.version}).`,
      `Hypothesis under test: ${input.hypothesis}`,
      'Score every criterion from 0 to 10. The criteria are fixed: score them exactly as written, never rewrite, add, or remove criteria.',
      'Criteria:',
      criteria,
    ]
    if (promptKills.length > 0) {
      lines.push(
        'Kill criteria — report any violation in outputs.kills with the matching criterionId:',
        promptKills.map((criterion) => `- ${criterion.id}: ${criterion.description}`).join('\n'),
      )
    }
    if (extraContext !== undefined) {
      lines.push(`Additional evidence requested by human judgment: ${extraContext}`)
    }
    lines.push(
      'Respond with outputs of the shape { "scores": [{ "criterionId": string, "score": number, "reason": string }], "evidence"?: string[], "kills"?: [{ "criterionId": string, "reason": string }], "risks"?: string[] }.',
    )
    return lines.join('\n')
  }

  private evaluatorContext(candidate: Candidate): string {
    const lines = [
      `Candidate "${candidate.title}" (iteration ${candidate.iteration})`,
      candidate.summary,
    ]
    for (const [name, value] of Object.entries(candidate.artifacts)) {
      lines.push(`Artifact ${name}: ${value}`)
    }
    for (const evidence of candidate.evidence) {
      lines.push(`Evidence: ${evidence}`)
    }
    return lines.join('\n')
  }

  private applyEvaluation(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    candidate: Candidate,
    outputs: Record<string, unknown>,
  ): Candidate {
    const { rubric } = input
    const scores = this.validateScores(record, rubric, outputs.scores)
    const evidence = [
      ...candidate.evidence,
      ...stringArray(outputs.evidence),
      ...stringArray(outputs.risks).map((risk) => `${RISK_PREFIX}${risk}`),
    ]
    const weighted = weightedScore(rubric, scores)
    const evaluated: Candidate = {
      ...candidate,
      status: 'evaluated',
      scores,
      weightedScore: weighted,
      evidence,
    }

    // Expression kill criteria are engine-evaluated against the documented scope.
    const scope = {
      candidate: {
        id: candidate.id,
        title: candidate.title,
        iteration: candidate.iteration,
        scores: Object.fromEntries(scores.map((score) => [score.criterionId, score.score])),
        weightedScore: weighted,
        evidenceCount: evidence.length,
        artifactCount: Object.keys(candidate.artifacts).length,
      },
      outputs,
    }
    for (const criterion of rubric.killCriteria) {
      if (criterion.expression === undefined) continue
      let matched: boolean
      try {
        matched = evaluateScopeExpression(criterion.expression, scope)
      } catch (error) {
        throw new OrchestratorError(
          `kill criterion '${criterion.id}' has an invalid expression: ${error instanceof Error ? error.message : String(error)}`,
          'invalid-input',
          { cause: error },
        )
      }
      if (matched) {
        return {
          ...evaluated,
          status: 'killed',
          killedBy: criterion.id,
          killReason: criterion.description,
        }
      }
    }

    // Expression-less kill criteria arrive back as evaluator-reported kills.
    const reportedKills = Array.isArray(outputs.kills) ? outputs.kills : []
    for (const kill of reportedKills) {
      if (typeof kill !== 'object' || kill === null) continue
      const shaped = kill as { criterionId?: unknown; reason?: unknown }
      const criterion = rubric.killCriteria.find(
        (entry) => entry.expression === undefined && entry.id === shaped.criterionId,
      )
      if (!criterion) continue
      return {
        ...evaluated,
        status: 'killed',
        killedBy: criterion.id,
        killReason: typeof shaped.reason === 'string' ? shaped.reason : criterion.description,
      }
    }

    if (weighted < rubric.advanceThreshold) {
      return {
        ...evaluated,
        status: 'killed',
        killedBy: 'below-threshold',
        killReason: `weighted score ${weighted.toFixed(2)} below advance threshold ${rubric.advanceThreshold}`,
      }
    }
    return evaluated
  }

  private validateScores(
    record: ExperimentRecord,
    rubric: EvaluationRubric,
    raw: unknown,
  ): CriterionScore[] {
    if (!Array.isArray(raw)) {
      throw new OrchestratorError(
        `evaluator returned no scores array for experiment '${record.id}'`,
        'corrupt-response',
      )
    }
    const known = new Set(rubric.criteria.map((criterion) => criterion.id))
    return raw.map((entry) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { criterionId?: unknown }).criterionId !== 'string' ||
        typeof (entry as { score?: unknown }).score !== 'number'
      ) {
        throw new OrchestratorError(
          `evaluator returned a malformed score entry for experiment '${record.id}'`,
          'corrupt-response',
        )
      }
      const shaped = entry as { criterionId: string; score: number; reason?: unknown }
      if (!known.has(shaped.criterionId)) {
        throw new OrchestratorError(
          `evaluator scored unknown criterion '${shaped.criterionId}' for experiment '${record.id}'`,
          'corrupt-response',
        )
      }
      return {
        criterionId: shaped.criterionId,
        score: shaped.score,
        reason: typeof shaped.reason === 'string' ? shaped.reason : '',
      }
    })
  }

  // -------------------------------------------------------------------------
  // Phases 4–5: select survivors, then request judgment
  // -------------------------------------------------------------------------

  private async select(record: ExperimentRecord, input: ExperimentStepInput): Promise<StepResult> {
    const { definition } = input
    const evaluated = rankedSurvivors(record)
    const keep = evaluated.slice(0, definition.survivorCount)
    const drop = evaluated.slice(definition.survivorCount)

    const updates = new Map<string, Candidate>()
    for (const candidate of drop) {
      updates.set(candidate.id, {
        ...candidate,
        status: 'killed',
        killedBy: 'not-selected',
        killReason: `ranked below survivor count ${definition.survivorCount} (weighted score ${(candidate.weightedScore ?? 0).toFixed(2)})`,
      })
    }
    let next: ExperimentRecord = {
      ...record,
      candidates: record.candidates.map((candidate) => updates.get(candidate.id) ?? candidate),
    }

    if (keep.length === 0) {
      const reasons = summarizeKills(next, record.iteration)
      const lesson = `all candidates killed in iteration ${record.iteration}: ${reasons}`
      if (record.iteration < definition.maxIterations) {
        next = await this.persist({
          ...next,
          iteration: record.iteration + 1,
          lessons: [...next.lessons, lesson],
        })
        return { type: 'continue', record: next }
      }
      const concluded = await this.conclude(next, 'exhausted', [
        lesson,
        `experiment exhausted: no survivors after ${record.iteration} of ${definition.maxIterations} iterations`,
      ])
      return this.concludedResult(concluded)
    }

    next = await this.persist({ ...next, status: 'awaiting-judgment' })
    return { type: 'awaiting-judgment', record: next, package: this.buildPackage(next, input) }
  }

  private buildPackage(record: ExperimentRecord, input: ExperimentStepInput): JudgmentPackage {
    const { rubric, definition } = input
    const survivors = rankedSurvivors(record)
    const top = survivors[0]
    const risks: string[] = []
    for (const candidate of survivors) {
      for (const entry of candidate.evidence) {
        if (entry.startsWith(RISK_PREFIX)) {
          const risk = entry.slice(RISK_PREFIX.length)
          if (!risks.includes(risk)) risks.push(risk)
        }
      }
    }
    return {
      experimentId: record.id,
      hypothesis: record.hypothesis,
      rubricSummary: `${rubric.name} v${input.rubric.version}: ${rubric.criteria.length} criteria, advance threshold ${rubric.advanceThreshold}`,
      killCriteria: rubric.killCriteria.map((criterion) => criterion.description),
      survivors: survivors.map((candidate) => ({
        candidateId: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        weightedScore: candidate.weightedScore ?? 0,
        artifacts: candidate.artifacts,
        keyEvidence: candidate.evidence
          .filter((entry) => !entry.startsWith(RISK_PREFIX))
          .slice(0, 3),
      })),
      recommendation: top
        ? `Advance "${top.title}" — highest weighted score ${(top.weightedScore ?? 0).toFixed(2)} of ${survivors.length} survivor(s). ${top.summary}`
        : 'No surviving candidate to recommend.',
      risks,
      iteration: record.iteration,
      maxIterations: definition.maxIterations,
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: resume with a judgment
  // -------------------------------------------------------------------------

  private async applyJudgment(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    judgment: JudgmentOutcome,
  ): Promise<StepResult> {
    switch (judgment.decision) {
      case 'advance':
        return this.judgmentAdvance(record, judgment)
      case 'kill':
        return this.judgmentKill(record, judgment)
      case 'iterate':
        return this.judgmentIterate(record, input, judgment)
      case 'need-more-evidence':
        return this.judgmentMoreEvidence(record, input, judgment)
    }
  }

  private async judgmentAdvance(
    record: ExperimentRecord,
    judgment: JudgmentOutcome,
  ): Promise<StepResult> {
    const survivors = rankedSurvivors(record)
    let selected = survivors[0]
    if (judgment.selectedCandidateId !== undefined) {
      selected = survivors.find((candidate) => candidate.id === judgment.selectedCandidateId)
      if (!selected) {
        throw new OrchestratorError(
          `judgment selected unknown candidate '${judgment.selectedCandidateId}' for experiment '${record.id}'`,
          'invalid-input',
        )
      }
    }
    if (!selected) {
      throw new OrchestratorError(
        `judgment advanced experiment '${record.id}' but no survivor exists`,
        'invalid-input',
      )
    }
    const chosen = selected
    const candidates = record.candidates.map((candidate): Candidate => {
      if (candidate.id === chosen.id) return { ...candidate, status: 'advanced' }
      if (candidate.status === 'evaluated' && candidate.iteration === record.iteration) {
        return {
          ...candidate,
          status: 'killed',
          killedBy: 'not-advanced',
          killReason: `human judgment advanced "${chosen.title}" instead`,
        }
      }
      return candidate
    })
    const concluded = await this.conclude({ ...record, candidates }, 'advanced', [
      `human judgment advanced "${chosen.title}"${judgment.feedback ? `: ${judgment.feedback}` : ''}`,
    ])
    return this.concludedResult(concluded)
  }

  private async judgmentKill(
    record: ExperimentRecord,
    judgment: JudgmentOutcome,
  ): Promise<StepResult> {
    const reason = judgment.feedback ?? 'killed by human judgment'
    const candidates = record.candidates.map(
      (candidate): Candidate =>
        candidate.status === 'evaluated' && candidate.iteration === record.iteration
          ? { ...candidate, status: 'killed', killedBy: 'human-judgment', killReason: reason }
          : candidate,
    )
    const concluded = await this.conclude({ ...record, candidates }, 'killed', [
      `human judgment killed the experiment: ${reason}`,
    ])
    return this.concludedResult(concluded)
  }

  private async judgmentIterate(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    judgment: JudgmentOutcome,
  ): Promise<StepResult> {
    const feedback = judgment.feedback ?? 'no feedback given'
    if (record.iteration >= input.definition.maxIterations) {
      const concluded = await this.conclude(record, 'exhausted', [
        `human judgment requested another iteration but ${record.iteration} of ${input.definition.maxIterations} iterations are spent: ${feedback}`,
      ])
      return this.concludedResult(concluded)
    }
    const next = await this.persist({
      ...record,
      status: 'running',
      iteration: record.iteration + 1,
      lessons: [
        ...record.lessons,
        `human judgment requested iteration ${record.iteration + 1}: ${feedback}`,
      ],
    })
    return { type: 'continue', record: next }
  }

  /**
   * Stay awaiting-judgment, but run at most one extra evaluator pass per
   * iteration (bounded via the iteration-tagged lesson marker) with the
   * judgment feedback appended, then rebuild the package.
   */
  private async judgmentMoreEvidence(
    record: ExperimentRecord,
    input: ExperimentStepInput,
    judgment: JudgmentOutcome,
  ): Promise<StepResult> {
    const feedback = judgment.feedback ?? 'no specifics given'
    const marker = evidencePassLesson(record.iteration)
    if (record.lessons.some((lesson) => lesson.startsWith(marker))) {
      const declined = `additional evidence request declined for iteration ${record.iteration}: evidence pass already completed`
      const next = record.lessons.includes(declined)
        ? record
        : await this.persist({ ...record, lessons: [...record.lessons, declined] })
      return { type: 'awaiting-judgment', record: next, package: this.buildPackage(next, input) }
    }

    const updates = new Map<string, Candidate>()
    for (const candidate of rankedSurvivors(record)) {
      const { outputs } = await this.deps.agents.run(
        this.evaluatorGoal(input, feedback),
        this.evaluatorContext(candidate),
        'evaluator',
      )
      const scores =
        outputs.scores !== undefined
          ? this.validateScores(record, input.rubric, outputs.scores)
          : candidate.scores
      updates.set(candidate.id, {
        ...candidate,
        scores,
        weightedScore: weightedScore(input.rubric, scores),
        evidence: [
          ...candidate.evidence,
          ...stringArray(outputs.evidence),
          ...stringArray(outputs.risks).map((risk) => `${RISK_PREFIX}${risk}`),
        ],
      })
    }
    const next = await this.persist({
      ...record,
      candidates: record.candidates.map((candidate) => updates.get(candidate.id) ?? candidate),
      lessons: [...record.lessons, `${marker} after judgment feedback: ${feedback}`],
    })
    return { type: 'awaiting-judgment', record: next, package: this.buildPackage(next, input) }
  }

  // -------------------------------------------------------------------------
  // Record plumbing
  // -------------------------------------------------------------------------

  private createRecord(input: ExperimentStepInput): ExperimentRecord {
    const now = this.clock.now()
    return {
      id: this.deps.ids.next('experiment'),
      runId: input.runId,
      nodeId: input.nodeId,
      experimentName: input.definition.name,
      experimentVersion: input.definition.version,
      rubricName: input.rubric.name,
      rubricVersion: input.rubric.version,
      hypothesis: input.hypothesis,
      iteration: 1,
      candidates: [],
      lessons: [],
      status: 'running',
      createdAt: now,
      updatedAt: now,
    }
  }

  private async persist(record: ExperimentRecord): Promise<ExperimentRecord> {
    const next = { ...record, updatedAt: this.clock.now() }
    await this.deps.experiments.save(next)
    return next
  }

  private async conclude(
    record: ExperimentRecord,
    conclusion: 'advanced' | 'killed' | 'exhausted',
    lessons: readonly string[],
  ): Promise<ExperimentRecord> {
    return this.persist({
      ...record,
      status: 'concluded',
      conclusion,
      lessons: [...record.lessons, ...lessons],
    })
  }

  private concludedResult(record: ExperimentRecord): StepResult {
    const conclusion = record.conclusion ?? 'exhausted'
    const selected = record.candidates.find((candidate) => candidate.status === 'advanced')
    return {
      type: 'concluded',
      record,
      conclusion,
      ...(selected ? { selected } : {}),
    }
  }
}

function candidatesOf(record: ExperimentRecord, iteration: number): readonly Candidate[] {
  return record.candidates.filter((candidate) => candidate.iteration === iteration)
}

/** Current-iteration survivors ranked by weighted score desc, id asc for ties. */
function rankedSurvivors(record: ExperimentRecord): Candidate[] {
  return candidatesOf(record, record.iteration)
    .filter((candidate) => candidate.status === 'evaluated')
    .slice()
    .sort(
      (a, b) =>
        (b.weightedScore ?? 0) - (a.weightedScore ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}

function summarizeKills(record: ExperimentRecord, iteration: number): string {
  const parts = candidatesOf(record, iteration)
    .filter((candidate) => candidate.status === 'killed')
    .map((candidate) => `"${candidate.title}" (${candidate.killedBy}: ${candidate.killReason})`)
  return parts.length > 0 ? parts.join('; ') : 'no candidates survived'
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/** Records may arrive from persistence after a JSON round-trip; coerce dates. */
function reviveRecord(record: ExperimentRecord): ExperimentRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }
}
