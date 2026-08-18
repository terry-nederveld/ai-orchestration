import type {
  Clock,
  CriterionScore,
  EvaluationRubric,
  ExperimentDefinition,
  ExperimentRecord,
  ExperimentRepository,
  IdGenerator,
  JudgmentOutcome,
  RunId,
} from '@overture/core'
import { asId, noopLogger, OrchestratorError } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { renderExperimentLearning } from './learning.js'
import {
  type ExperimentAgentRole,
  type ExperimentAgents,
  ExperimentRunner,
  type ExperimentStepInput,
  type StepResult,
} from './runner.js'

// ---------------------------------------------------------------------------
// Fakes: JSON-round-tripping repository, scripted agents, fixed clock/ids
// ---------------------------------------------------------------------------

class FakeExperimentRepository implements ExperimentRepository {
  saves = 0
  private readonly rows = new Map<string, string>()

  async save(record: ExperimentRecord): Promise<void> {
    this.saves += 1
    this.rows.set(record.id, JSON.stringify(record))
  }

  async get(id: string): Promise<ExperimentRecord | undefined> {
    const row = this.rows.get(id)
    return row ? (JSON.parse(row) as ExperimentRecord) : undefined
  }

  async listForRun(runId: RunId): Promise<readonly ExperimentRecord[]> {
    return [...this.rows.values()]
      .map((row) => JSON.parse(row) as ExperimentRecord)
      .filter((record) => record.runId === runId)
  }
}

interface ScriptEntry {
  readonly role: ExperimentAgentRole
  readonly outputs?: Record<string, unknown>
  readonly error?: string
}

class ScriptedAgents implements ExperimentAgents {
  readonly calls: Array<{ goal: string; context: string; role: ExperimentAgentRole }> = []

  constructor(private readonly script: ScriptEntry[]) {}

  async run(goal: string, context: string, role: ExperimentAgentRole) {
    this.calls.push({ goal, context, role })
    const next = this.script.shift()
    if (!next) throw new Error(`unexpected agent call for role '${role}'`)
    if (next.role !== role) throw new Error(`script expected role '${next.role}', got '${role}'`)
    if (next.error !== undefined) throw new Error(next.error)
    return { outputs: next.outputs ?? {}, summary: 'scripted' }
  }
}

function makeHarness(script: ScriptEntry[]) {
  const repo = new FakeExperimentRepository()
  const agents = new ScriptedAgents(script)
  let sequence = 0
  const ids: IdGenerator = {
    next: (prefix) => {
      sequence += 1
      return `${prefix}-${sequence}`
    },
  }
  let nowMs = 0
  const clock: Clock = { now: () => new Date(nowMs) }
  const advance = (ms: number) => {
    nowMs += ms
  }
  // A fresh runner per step proves the machine holds no in-memory state.
  const runner = () =>
    new ExperimentRunner({ agents, experiments: repo, clock, ids, logger: noopLogger })
  return { repo, agents, runner, advance }
}

type Harness = ReturnType<typeof makeHarness>
type BaseInput = Omit<ExperimentStepInput, 'record' | 'judgment'>

/**
 * Step until the machine pauses (awaiting-judgment or concluded), rebuilding
 * the runner between every step and loading the record only from the
 * repository (which JSON round-trips it).
 */
async function drive(
  harness: Harness,
  base: BaseInput,
  options?: { recordId?: string; judgment?: JudgmentOutcome },
): Promise<{ result: StepResult; recordId: string }> {
  let recordId = options?.recordId
  let judgment = options?.judgment
  for (let steps = 0; steps < 50; steps += 1) {
    const record = recordId ? await harness.repo.get(recordId) : undefined
    const result = await harness.runner().step({
      ...base,
      ...(record ? { record } : {}),
      ...(judgment ? { judgment } : {}),
    })
    judgment = undefined
    recordId = result.record.id
    if (result.type !== 'continue') return { result, recordId }
  }
  throw new Error('drive did not pause within 50 steps')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const runId = asId<'run'>('run-1')

const rubric: EvaluationRubric & { version: number } = {
  name: 'quality',
  version: 3,
  criteria: [
    { id: 'impact', description: 'Impact on the mission', weight: 2 },
    { id: 'effort', description: 'Low implementation effort', weight: 1 },
  ],
  killCriteria: [],
  advanceThreshold: 5,
}

const definition: ExperimentDefinition & { version: number } = {
  name: 'routing-experiment',
  version: 2,
  candidateCount: 2,
  generationStrategy: 'diverge widely',
  rubric: 'quality',
  prototype: false,
  survivorCount: 2,
  maxIterations: 2,
}

const baseInput = (overrides?: {
  definition?: Partial<ExperimentDefinition & { version: number }>
  rubric?: Partial<EvaluationRubric & { version: number }>
}): BaseInput => ({
  definition: { ...definition, ...overrides?.definition },
  rubric: { ...rubric, ...overrides?.rubric },
  hypothesis: 'adaptive routing reduces cost',
  runId,
  nodeId: 'node-exp',
})

const scores = (impact: number, effort: number): CriterionScore[] => [
  { criterionId: 'impact', score: impact, reason: 'impact reason' },
  { criterionId: 'effort', score: effort, reason: 'effort reason' },
]

const generated = (...titles: string[]) => ({
  candidates: titles.map((title) => ({ title, summary: `${title} summary` })),
})

const judgment = (
  experimentId: string,
  decision: JudgmentOutcome['decision'],
  extra?: Partial<JudgmentOutcome>,
): JudgmentOutcome => ({
  experimentId,
  decision,
  decidedBy: 'terry',
  at: new Date(0),
  ...extra,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExperimentRunner', () => {
  it('runs generate → prototype → evaluate → judgment advance to conclusion', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Alpha', 'Beta') },
      {
        role: 'prototyper',
        outputs: { artifacts: { branch: 'exp/alpha' }, evidence: ['alpha builds'] },
      },
      {
        role: 'prototyper',
        outputs: { artifacts: { branch: 'exp/beta' }, evidence: ['beta builds'] },
      },
      {
        role: 'evaluator',
        outputs: { scores: scores(8, 7), evidence: ['fast'], risks: ['cache staleness'] },
      },
      { role: 'evaluator', outputs: { scores: scores(6, 6) } },
    ])
    const input = baseInput({ definition: { prototype: true } })

    const { result, recordId } = await drive(harness, input)
    expect(result.type).toBe('awaiting-judgment')
    if (result.type !== 'awaiting-judgment') return

    // Package: ranked survivors, pinned rubric summary, risks, recommendation.
    expect(result.package.survivors.map((survivor) => survivor.title)).toEqual(['Alpha', 'Beta'])
    expect(result.package.rubricSummary).toContain('quality v3')
    expect(result.package.recommendation).toContain('Alpha')
    expect(result.package.risks).toEqual(['cache staleness'])
    expect(result.package.survivors[0]?.artifacts).toEqual({ branch: 'exp/alpha' })
    expect(result.package.survivors[0]?.keyEvidence).toEqual(['alpha builds', 'fast'])

    // Evaluator goal carried the rubric criteria verbatim.
    const evaluatorCall = harness.agents.calls.find((call) => call.role === 'evaluator')
    expect(evaluatorCall?.goal).toContain('- impact (weight 2): Impact on the mission')
    expect(evaluatorCall?.goal).toContain('- effort (weight 1): Low implementation effort')

    const alphaId = result.package.survivors[0]?.candidateId ?? ''
    const done = await drive(harness, input, {
      recordId,
      judgment: judgment(recordId, 'advance', {
        selectedCandidateId: alphaId,
        feedback: 'ship it',
      }),
    })
    expect(done.result.type).toBe('concluded')
    if (done.result.type !== 'concluded') return
    expect(done.result.conclusion).toBe('advanced')
    expect(done.result.selected?.title).toBe('Alpha')
    expect(done.result.selected?.status).toBe('advanced')
    const beta = done.result.record.candidates.find((candidate) => candidate.title === 'Beta')
    expect(beta?.status).toBe('killed')
    expect(beta?.killedBy).toBe('not-advanced')
    expect(done.result.record.lessons.join('\n')).toContain('advanced "Alpha": ship it')

    // Every phase persisted: generate, prototype, evaluate, select, conclude.
    expect(harness.repo.saves).toBe(5)
  })

  it('kills candidates via expression kill criteria', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Zero', 'Fine') },
      { role: 'evaluator', outputs: { scores: scores(0, 9) } },
      { role: 'evaluator', outputs: { scores: scores(7, 7) } },
    ])
    const input = baseInput({
      rubric: {
        killCriteria: [
          {
            id: 'no-impact',
            description: 'candidates with zero impact are dead on arrival',
            expression: 'candidate.scores.impact == 0',
          },
        ],
        advanceThreshold: 0,
      },
    })

    const { result } = await drive(harness, input)
    expect(result.type).toBe('awaiting-judgment')
    const zero = result.record.candidates.find((candidate) => candidate.title === 'Zero')
    expect(zero?.status).toBe('killed')
    expect(zero?.killedBy).toBe('no-impact')
    expect(zero?.killReason).toBe('candidates with zero impact are dead on arrival')
    expect(result.record.lessons.join('\n')).toContain('killed by no-impact')
  })

  it('kills candidates via evaluator-reported expression-less kill criteria', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Risky', 'Safe') },
      {
        role: 'evaluator',
        outputs: {
          scores: scores(9, 9),
          kills: [{ criterionId: 'security', reason: 'found SQL injection' }],
        },
      },
      { role: 'evaluator', outputs: { scores: scores(7, 7) } },
    ])
    const input = baseInput({
      rubric: {
        killCriteria: [{ id: 'security', description: 'no exploitable vulnerabilities' }],
      },
    })

    const { result } = await drive(harness, input)
    expect(result.type).toBe('awaiting-judgment')
    const risky = result.record.candidates.find((candidate) => candidate.title === 'Risky')
    expect(risky?.status).toBe('killed')
    expect(risky?.killedBy).toBe('security')
    expect(risky?.killReason).toBe('found SQL injection')

    // The expression-less criterion was put in front of the evaluator.
    const evaluatorCall = harness.agents.calls.find((call) => call.role === 'evaluator')
    expect(evaluatorCall?.goal).toContain('security: no exploitable vulnerabilities')
  })

  it('kills candidates below the advance threshold', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Weak', 'Strong') },
      { role: 'evaluator', outputs: { scores: scores(2, 2) } },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
    ])

    const { result } = await drive(harness, baseInput())
    expect(result.type).toBe('awaiting-judgment')
    const weak = result.record.candidates.find((candidate) => candidate.title === 'Weak')
    expect(weak?.status).toBe('killed')
    expect(weak?.killedBy).toBe('below-threshold')
    expect(weak?.killReason).toContain('below advance threshold 5')
    if (result.type !== 'awaiting-judgment') return
    expect(result.package.survivors.map((survivor) => survivor.title)).toEqual(['Strong'])
  })

  it('iterates on zero survivors and concludes exhausted at maxIterations', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('First') },
      { role: 'evaluator', outputs: { scores: scores(1, 1) } },
      { role: 'generator', outputs: generated('Second') },
      { role: 'evaluator', outputs: { scores: scores(1, 1) } },
    ])
    const input = baseInput({ definition: { candidateCount: 1, survivorCount: 1 } })

    const { result } = await drive(harness, input)
    expect(result.type).toBe('concluded')
    if (result.type !== 'concluded') return
    expect(result.conclusion).toBe('exhausted')
    expect(result.record.iteration).toBe(2)
    const lessons = result.record.lessons.join('\n')
    expect(lessons).toContain('all candidates killed in iteration 1')
    expect(lessons).toContain('all candidates killed in iteration 2')
    expect(lessons).toContain('exhausted')
    // Second-iteration generation received the first iteration's lesson.
    const secondGeneration = harness.agents.calls.filter((call) => call.role === 'generator')[1]
    expect(secondGeneration?.context).toContain('all candidates killed in iteration 1')
  })

  it('bounds judgment iterate loops by maxIterations', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('One') },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
      { role: 'generator', outputs: generated('Two') },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
    ])
    const input = baseInput({ definition: { candidateCount: 1, survivorCount: 1 } })

    const first = await drive(harness, input)
    expect(first.result.type).toBe('awaiting-judgment')

    const second = await drive(harness, input, {
      recordId: first.recordId,
      judgment: judgment(first.recordId, 'iterate', { feedback: 'try smaller scope' }),
    })
    expect(second.result.type).toBe('awaiting-judgment')
    expect(second.result.record.iteration).toBe(2)
    expect(second.result.record.lessons.join('\n')).toContain(
      'human judgment requested iteration 2: try smaller scope',
    )

    const third = await drive(harness, input, {
      recordId: second.recordId,
      judgment: judgment(second.recordId, 'iterate', { feedback: 'again' }),
    })
    expect(third.result.type).toBe('concluded')
    if (third.result.type !== 'concluded') return
    expect(third.result.conclusion).toBe('exhausted')
  })

  it('runs exactly one bounded extra evidence pass per iteration on need-more-evidence', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Solo') },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
      { role: 'evaluator', outputs: { evidence: ['p99 latency 5ms'], risks: ['single region'] } },
    ])
    const input = baseInput({ definition: { candidateCount: 1, survivorCount: 1 } })

    const first = await drive(harness, input)
    expect(first.result.type).toBe('awaiting-judgment')

    const second = await drive(harness, input, {
      recordId: first.recordId,
      judgment: judgment(first.recordId, 'need-more-evidence', { feedback: 'measure latency' }),
    })
    expect(second.result.type).toBe('awaiting-judgment')
    if (second.result.type !== 'awaiting-judgment') return
    expect(harness.agents.calls.filter((call) => call.role === 'evaluator')).toHaveLength(2)
    const extraPass = harness.agents.calls.at(-1)
    expect(extraPass?.goal).toContain(
      'Additional evidence requested by human judgment: measure latency',
    )
    expect(second.result.package.survivors[0]?.keyEvidence).toContain('p99 latency 5ms')
    expect(second.result.package.risks).toContain('single region')
    // Scores survived the evidence-only pass.
    expect(second.result.package.survivors[0]?.weightedScore).toBe(8)
    expect(second.result.record.lessons.join('\n')).toContain(
      'additional evidence gathered for iteration 1',
    )

    // A second request in the same iteration is declined: no agent calls.
    const third = await drive(harness, input, {
      recordId: second.recordId,
      judgment: judgment(second.recordId, 'need-more-evidence', { feedback: 'more!' }),
    })
    expect(third.result.type).toBe('awaiting-judgment')
    expect(harness.agents.calls.filter((call) => call.role === 'evaluator')).toHaveLength(2)
    expect(third.result.record.lessons.join('\n')).toContain(
      'additional evidence request declined for iteration 1',
    )

    const done = await drive(harness, input, {
      recordId: third.recordId,
      judgment: judgment(third.recordId, 'advance'),
    })
    expect(done.result.type).toBe('concluded')
  })

  it('kills only the failing candidate on prototype failure', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Broken', 'Working') },
      { role: 'prototyper', error: 'build exploded' },
      { role: 'prototyper', outputs: { artifacts: { branch: 'exp/working' } } },
      { role: 'evaluator', outputs: { scores: scores(7, 7) } },
    ])
    const input = baseInput({ definition: { prototype: true } })

    const { result } = await drive(harness, input)
    expect(result.type).toBe('awaiting-judgment')
    if (result.type !== 'awaiting-judgment') return
    const broken = result.record.candidates.find((candidate) => candidate.title === 'Broken')
    expect(broken?.status).toBe('killed')
    expect(broken?.killedBy).toBe('prototype-failure')
    expect(broken?.killReason).toBe('build exploded')
    expect(result.package.survivors.map((survivor) => survivor.title)).toEqual(['Working'])
    expect(result.record.lessons.join('\n')).toContain('prototype failed for "Broken"')
  })

  it('rejects malformed generator output as corrupt-response', async () => {
    const harness = makeHarness([{ role: 'generator', outputs: { candidates: 'not an array' } }])
    await expect(harness.runner().step(baseInput())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestratorError && error.category === 'corrupt-response',
    )
  })

  it('rejects evaluator scores with unknown criterion ids as corrupt-response', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Solo') },
      {
        role: 'evaluator',
        outputs: { scores: [{ criterionId: 'bogus', score: 5, reason: 'made up' }] },
      },
    ])
    const input = baseInput({ definition: { candidateCount: 1 } })
    const first = await harness.runner().step(input)
    const record = await harness.repo.get(first.record.id)
    if (!record) throw new Error('record not persisted')
    await expect(harness.runner().step({ ...input, record })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestratorError &&
        error.category === 'corrupt-response' &&
        error.message.includes('bogus'),
    )
  })

  it('caps generated candidates at candidateCount', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('A', 'B', 'C', 'D') },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
      { role: 'evaluator', outputs: { scores: scores(7, 7) } },
    ])
    const { result } = await drive(harness, baseInput())
    expect(result.record.candidates).toHaveLength(2)
  })

  it('concludes exhausted when maxWallClockMs is exceeded', async () => {
    const harness = makeHarness([{ role: 'generator', outputs: generated('Slow', 'Late') }])
    const input = baseInput({ definition: { maxWallClockMs: 1_000 } })

    const first = await harness.runner().step(input)
    expect(first.type).toBe('continue')
    harness.advance(2_000)
    const record = await harness.repo.get(first.record.id)
    if (!record) throw new Error('record not persisted')
    const result = await harness.runner().step({ ...input, record })
    expect(result.type).toBe('concluded')
    if (result.type !== 'concluded') return
    expect(result.conclusion).toBe('exhausted')
    expect(result.record.lessons.join('\n')).toContain('wall clock budget exhausted after 2000ms')
  })

  it('concludes killed on judgment kill, preserving the feedback as a lesson', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Solo') },
      { role: 'evaluator', outputs: { scores: scores(8, 8) } },
    ])
    const input = baseInput({ definition: { candidateCount: 1, survivorCount: 1 } })
    const first = await drive(harness, input)
    const done = await drive(harness, input, {
      recordId: first.recordId,
      judgment: judgment(first.recordId, 'kill', { feedback: 'wrong direction entirely' }),
    })
    expect(done.result.type).toBe('concluded')
    if (done.result.type !== 'concluded') return
    expect(done.result.conclusion).toBe('killed')
    expect(done.result.record.lessons.join('\n')).toContain('wrong direction entirely')
    const solo = done.result.record.candidates[0]
    expect(solo?.status).toBe('killed')
    expect(solo?.killedBy).toBe('human-judgment')
  })

  it('selects only survivorCount candidates and kills the rest as not-selected', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Best', 'Second') },
      { role: 'evaluator', outputs: { scores: scores(9, 9) } },
      { role: 'evaluator', outputs: { scores: scores(7, 7) } },
    ])
    const input = baseInput({ definition: { survivorCount: 1 } })
    const { result } = await drive(harness, input)
    expect(result.type).toBe('awaiting-judgment')
    if (result.type !== 'awaiting-judgment') return
    expect(result.package.survivors.map((survivor) => survivor.title)).toEqual(['Best'])
    const second = result.record.candidates.find((candidate) => candidate.title === 'Second')
    expect(second?.status).toBe('killed')
    expect(second?.killedBy).toBe('not-selected')
  })
})

describe('renderExperimentLearning', () => {
  it('renders hypothesis, criteria versions, rejections, selection, and lessons', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('Winner', 'Loser') },
      { role: 'evaluator', outputs: { scores: scores(9, 9), risks: ['migration risk'] } },
      { role: 'evaluator', outputs: { scores: scores(2, 2) } },
    ])
    const input = baseInput()
    const first = await drive(harness, input)
    expect(first.result.type).toBe('awaiting-judgment')
    const done = await drive(harness, input, {
      recordId: first.recordId,
      judgment: judgment(first.recordId, 'advance', { feedback: 'clear winner' }),
    })
    expect(done.result.type).toBe('concluded')

    const markdown = renderExperimentLearning(done.result.record)
    expect(markdown).toContain('**Hypothesis:** adaptive routing reduces cost')
    expect(markdown).toContain('`routing-experiment` version 2')
    expect(markdown).toContain('`quality` version 3')
    expect(markdown).toContain('## Rejected approaches')
    expect(markdown).toContain('below-threshold')
    expect(markdown).toContain('below advance threshold 5')
    expect(markdown).toContain('## Selected approach')
    expect(markdown).toContain('"Winner"')
    expect(markdown).toContain('Why: human judgment advanced "Winner": clear winner')
    expect(markdown).toContain('Risk: migration risk')
    expect(markdown).toContain('## Lessons')
    // Deterministic: rendering the same record twice is identical.
    expect(renderExperimentLearning(done.result.record)).toBe(markdown)
  })

  it('renders every iteration in ascending order', async () => {
    const harness = makeHarness([
      { role: 'generator', outputs: generated('First') },
      { role: 'evaluator', outputs: { scores: scores(1, 1) } },
      { role: 'generator', outputs: generated('Second') },
      { role: 'evaluator', outputs: { scores: scores(1, 1) } },
    ])
    const input = baseInput({ definition: { candidateCount: 1, survivorCount: 1 } })
    const { result } = await drive(harness, input)
    const markdown = renderExperimentLearning(result.record)
    expect(markdown.indexOf('## Iteration 1')).toBeGreaterThan(-1)
    expect(markdown.indexOf('## Iteration 2')).toBeGreaterThan(markdown.indexOf('## Iteration 1'))
  })
})
