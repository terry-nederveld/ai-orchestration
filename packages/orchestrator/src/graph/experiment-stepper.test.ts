import {
  asId,
  type EvaluationRubric,
  type ExperimentDefinition,
  type IdGenerator,
  noopLogger,
  type RunId,
  systemClock,
} from '@overture/core'
import type { ExperimentAgents } from '@overture/experiments'
import { InMemoryPersistenceProvider } from '@overture/persistence'
import { describe, expect, it } from 'vitest'
import {
  createExperimentStepper,
  decodeJudgment,
  EXPERIMENT_JUDGMENT_REASON,
  judgmentChoices,
} from './experiment-stepper.js'

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

const definition: ExperimentDefinition & { version: number } = {
  name: 'exp',
  candidateCount: 2,
  rubric: 'rubric',
  prototype: false,
  survivorCount: 2,
  maxIterations: 2,
  version: 1,
}

const rubric: EvaluationRubric & { version: number } = {
  name: 'rubric',
  criteria: [{ id: 'impact', description: 'impact', weight: 1 }],
  killCriteria: [],
  advanceThreshold: 5,
  version: 1,
}

/** Scripted agents: generator emits two candidates, evaluator scores them. */
function scriptedAgents(scores: Record<string, number> = { A: 8, B: 6 }): ExperimentAgents {
  return {
    async run(_goal, context, role) {
      if (role === 'generator') {
        return {
          outputs: {
            candidates: [
              { title: 'A', summary: 'approach A' },
              { title: 'B', summary: 'approach B' },
            ],
          },
          summary: 'generated',
        }
      }
      const title = /Candidate "([^"]+)"/.exec(context)?.[1] ?? 'A'
      return {
        outputs: {
          scores: [{ criterionId: 'impact', score: scores[title] ?? 5, reason: 'scored' }],
        },
        summary: 'evaluated',
      }
    },
  }
}

function makeStepper(persistence: InMemoryPersistenceProvider, agents: ExperimentAgents) {
  return createExperimentStepper({
    agents,
    experiments: persistence.experiments,
    judgments: persistence.judgments,
    ids: new SequentialIds(),
    clock: systemClock,
    logger: noopLogger,
  })
}

const baseInput = {
  runId: 'run-1',
  nodeId: 'experiment',
  definition,
  rubric,
  hypothesis: 'a better approach exists',
}

describe('createExperimentStepper', () => {
  it('drives an experiment from nothing to a durable judgment wait', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const stepper = makeStepper(persistence, scriptedAgents())

    const yielded = await stepper.step(baseInput)
    if (yielded.type !== 'wait') throw new Error(`expected wait, got ${JSON.stringify(yielded)}`)
    expect(yielded.spec.kind).toBe('human-input')
    expect(yielded.spec.parameters?.reason).toBe(EXPERIMENT_JUDGMENT_REASON)
    expect(yielded.request?.type).toBe('single-choice')
    expect(yielded.request?.choices).toHaveLength(5)
    expect(yielded.request?.choices?.filter((c) => c.startsWith('advance:'))).toHaveLength(2)
    expect(yielded.request?.choices).toContain('kill')

    const records = await persistence.experiments.listForRun(asId('run-1') as RunId)
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('awaiting-judgment')
  })

  it('resumes on a brand-new stepper and concludes advanced from an advance choice', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const first = makeStepper(persistence, scriptedAgents())
    const waited = await first.step(baseInput)
    if (waited.type !== 'wait') throw new Error('expected wait')
    const advanceChoice = waited.request?.choices?.find((c) => c.startsWith('advance:'))
    if (!advanceChoice) throw new Error('expected an advance choice')

    // A different stepper instance: only the persisted record carries state.
    const second = makeStepper(persistence, scriptedAgents())
    const concluded = await second.step({
      ...baseInput,
      satisfaction: {
        kind: 'human-input',
        at: new Date(),
        input: {
          requestId: 'req-1',
          responder: 'terry',
          channel: 'app',
          at: new Date(),
          value: advanceChoice,
        },
      },
    })
    if (concluded.type !== 'result') throw new Error('expected result')
    expect(concluded.status).toBe('succeeded')
    expect(concluded.outputs?.conclusion).toBe('advanced')
    const selected = concluded.outputs?.selected as { candidateId: string; title: string }
    expect(`advance:${selected.candidateId}`).toBe(advanceChoice)
    expect(selected.title).toBe('A')
    expect(String(concluded.outputs?.learning)).toContain('a better approach exists')

    const record = (await persistence.experiments.listForRun(asId('run-1') as RunId))[0]
    const judgments = await persistence.judgments.listForExperiment(record?.id ?? '')
    expect(judgments).toHaveLength(1)
    expect(judgments[0]?.decision).toBe('advance')
    expect(judgments[0]?.decidedBy).toBe('terry')
  })

  it('concludes killed on a kill judgment, still settling the node as succeeded', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const stepper = makeStepper(persistence, scriptedAgents())
    const waited = await stepper.step(baseInput)
    if (waited.type !== 'wait') throw new Error('expected wait')

    const concluded = await stepper.step({
      ...baseInput,
      satisfaction: {
        kind: 'human-input',
        at: new Date(),
        input: {
          requestId: 'req-1',
          responder: 'terry',
          channel: 'app',
          at: new Date(),
          value: 'kill',
        },
      },
    })
    if (concluded.type !== 'result') throw new Error('expected result')
    expect(concluded.status).toBe('succeeded')
    expect(concluded.outputs?.conclusion).toBe('killed')
  })

  it('iterates within the bound and exhausts at maxIterations', async () => {
    const persistence = new InMemoryPersistenceProvider()
    const stepper = makeStepper(persistence, scriptedAgents())
    const first = await stepper.step(baseInput)
    if (first.type !== 'wait') throw new Error('expected first wait')

    const iterate = (at: Date) => ({
      ...baseInput,
      satisfaction: {
        kind: 'human-input' as const,
        at,
        input: {
          requestId: 'req',
          responder: 'terry',
          channel: 'app' as const,
          at,
          value: 'iterate',
        },
      },
    })

    // Iteration 2 of 2 still runs and asks for judgment again.
    const second = await stepper.step(iterate(new Date()))
    if (second.type !== 'wait')
      throw new Error(`expected second wait, got ${JSON.stringify(second)}`)
    const record = (await persistence.experiments.listForRun(asId('run-1') as RunId))[0]
    expect(record?.iteration).toBe(2)

    // A third iterate request exceeds the bound: exhausted, not another loop.
    const third = await stepper.step(iterate(new Date()))
    if (third.type !== 'result') throw new Error('expected exhausted result')
    expect(third.outputs?.conclusion).toBe('exhausted')
  })

  it('rejects malformed judgment choices', () => {
    expect(() =>
      decodeJudgment('exp-1', { value: 'advance:', responder: 'terry', at: new Date() }),
    ).toThrow(/names no candidate/)
    expect(() =>
      decodeJudgment('exp-1', { value: 'ship-it', responder: 'terry', at: new Date() }),
    ).toThrow(/unrecognized/)
  })

  it('encodes one advance choice per survivor', () => {
    const choices = judgmentChoices({
      experimentId: 'e',
      hypothesis: 'h',
      rubricSummary: 'r',
      killCriteria: [],
      survivors: [
        {
          candidateId: 'c1',
          title: 'A',
          summary: 's',
          weightedScore: 7,
          artifacts: {},
          keyEvidence: [],
        },
      ],
      recommendation: 'advance A',
      risks: [],
      iteration: 1,
      maxIterations: 3,
    })
    expect(choices).toEqual(['advance:c1', 'iterate', 'need-more-evidence', 'kill'])
  })
})
