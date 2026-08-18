/**
 * Experimentation primitive (mission §13–§15): hypothesis → candidates →
 * build/test → evaluate against a rubric pinned before evaluation →
 * kill/advance → durable learning. Human judgment consumes a compact
 * JudgmentPackage; iteration is a declared, bounded loop.
 */

import type { RunId } from './ids.js'

// ---------------------------------------------------------------------------
// Rubrics (§14)
// ---------------------------------------------------------------------------

export interface RubricCriterion {
  readonly id: string
  readonly description: string
  /** Relative weight; scores are 0–10 per criterion. */
  readonly weight: number
}

export interface KillCriterion {
  readonly id: string
  readonly description: string
  /** Expression over candidate evidence; true kills the candidate. */
  readonly expression?: string
}

export interface EvaluationRubric {
  readonly name: string
  readonly description?: string
  readonly criteria: readonly RubricCriterion[]
  readonly killCriteria: readonly KillCriterion[]
  /** Weighted score (0–10) a candidate must reach to survive. */
  readonly advanceThreshold: number
}

export interface CriterionScore {
  readonly criterionId: string
  readonly score: number
  readonly reason: string
}

export function weightedScore(rubric: EvaluationRubric, scores: readonly CriterionScore[]): number {
  const totalWeight = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (totalWeight === 0) return 0
  let weighted = 0
  for (const criterion of rubric.criteria) {
    const score = scores.find((entry) => entry.criterionId === criterion.id)
    weighted += (score?.score ?? 0) * criterion.weight
  }
  return weighted / totalWeight
}

// ---------------------------------------------------------------------------
// Experiments (§13)
// ---------------------------------------------------------------------------

export interface ExperimentDefinition {
  readonly name: string
  readonly description?: string
  /** How many candidates to generate per round. */
  readonly candidateCount: number
  /** Generation strategy hint handed to the generation profile. */
  readonly generationStrategy?: string
  /** Rubric reference (pinned into the snapshot before evaluation). */
  readonly rubric: string
  /** Build/test candidates when practical, not just written proposals. */
  readonly prototype: boolean
  readonly survivorCount: number
  readonly maxIterations: number
  readonly maxWallClockMs?: number
  readonly budgetName?: string
}

export type CandidateStatus = 'generated' | 'prototyped' | 'evaluated' | 'killed' | 'advanced'

export interface Candidate {
  readonly id: string
  readonly iteration: number
  readonly title: string
  readonly summary: string
  readonly status: CandidateStatus
  /** Prototype coordinates: branch, workspace, artifact paths. */
  readonly artifacts: Readonly<Record<string, string>>
  readonly evidence: readonly string[]
  readonly scores: readonly CriterionScore[]
  readonly weightedScore?: number
  readonly killedBy?: string
  readonly killReason?: string
}

export interface ExperimentRecord {
  readonly id: string
  readonly runId: RunId
  readonly nodeId: string
  readonly experimentName: string
  readonly experimentVersion: number
  readonly rubricName: string
  readonly rubricVersion: number
  readonly hypothesis: string
  readonly iteration: number
  readonly candidates: readonly Candidate[]
  readonly lessons: readonly string[]
  readonly status: 'running' | 'awaiting-judgment' | 'concluded'
  readonly conclusion?: 'advanced' | 'killed' | 'exhausted'
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ExperimentRepository {
  save(record: ExperimentRecord): Promise<void>
  get(id: string): Promise<ExperimentRecord | undefined>
  listForRun(runId: RunId): Promise<readonly ExperimentRecord[]>
}

// ---------------------------------------------------------------------------
// Judgment (§15–§16)
// ---------------------------------------------------------------------------

export type JudgmentDecision = 'kill' | 'advance' | 'iterate' | 'need-more-evidence'

export interface JudgmentPackage {
  readonly experimentId: string
  readonly hypothesis: string
  readonly rubricSummary: string
  readonly killCriteria: readonly string[]
  readonly survivors: ReadonlyArray<{
    readonly candidateId: string
    readonly title: string
    readonly summary: string
    readonly weightedScore: number
    readonly artifacts: Readonly<Record<string, string>>
    readonly keyEvidence: readonly string[]
  }>
  readonly recommendation: string
  readonly risks: readonly string[]
  readonly iteration: number
  readonly maxIterations: number
}

export interface JudgmentOutcome {
  readonly experimentId: string
  readonly decision: JudgmentDecision
  readonly selectedCandidateId?: string
  readonly feedback?: string
  readonly decidedBy: string
  readonly at: Date
}

export interface JudgmentRepository {
  save(outcome: JudgmentOutcome): Promise<void>
  listForExperiment(experimentId: string): Promise<readonly JudgmentOutcome[]>
  /** All outcomes in a period, for judgment observability. */
  listForPeriod(start: Date, end: Date): Promise<readonly JudgmentOutcome[]>
}
