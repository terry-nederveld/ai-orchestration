import { describe, expect, it } from 'vitest'
import {
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  readManagedSection,
  upsertManagedSection,
} from './checkpoints.js'
import { assembleContext } from './context.js'
import { canonicalizeDocument } from './definitions.js'
import { type ExecutionSpecification, specsMateriallyDiffer } from './execution-spec.js'
import { type EvaluationRubric, weightedScore } from './experiments.js'
import { composeGateSets, type GateSet } from './gates.js'
import type { GraphNode, GraphTransition, WorkflowGraph } from './graph.js'
import { validateGraph } from './graph-validate.js'
import { asId } from './ids.js'
import { type InstructionDocument, mergeInstructions } from './instructions.js'
import { evaluatePredicate, type MappingRuleSet, resolveRepositories } from './mapping.js'
import { composeProfile, ProfileCompositionError } from './profiles.js'
import { assertTransition, canTransition, RunState } from './run.js'
import { InputValidationFailure, validateHumanInputValue } from './waits.js'
import type { WorkItem } from './work.js'

const node = (id: string, kind: 'agent' | 'terminal' = 'agent'): GraphNode =>
  kind === 'terminal'
    ? { id, config: { kind: 'terminal', outcome: 'completed' } }
    : { id, config: { kind: 'agent', goal: `do ${id}` } }

const t = (
  id: string,
  from: string,
  to: string,
  extra: Partial<GraphTransition> = {},
): GraphTransition => ({
  id,
  from,
  to,
  ...extra,
})

describe('graph validation', () => {
  const goodGraph: WorkflowGraph = {
    name: 'g',
    entry: 'a',
    nodes: [node('a'), node('b'), node('end', 'terminal')],
    transitions: [t('t1', 'a', 'b'), t('t2', 'b', 'end')],
  }

  it('accepts a valid linear graph', () => {
    expect(validateGraph(goodGraph)).toEqual([])
  })

  it('rejects unknown entry, duplicate ids, and dangling transitions', () => {
    const issues = validateGraph({
      name: 'bad',
      entry: 'missing',
      nodes: [node('a'), node('a')],
      transitions: [t('t1', 'a', 'nowhere')],
    })
    const messages = issues.map((issue) => issue.message).join('; ')
    expect(messages).toContain('duplicate node id')
    expect(messages).toContain("entry node 'missing' does not exist")
    expect(messages).toContain("unknown target node 'nowhere'")
  })

  it('rejects unreachable nodes and missing terminals', () => {
    const issues = validateGraph({
      name: 'bad',
      entry: 'a',
      nodes: [node('a'), node('orphan')],
      transitions: [],
    })
    const messages = issues.map((issue) => issue.message).join('; ')
    expect(messages).toContain('unreachable from entry')
    expect(messages).toContain('no reachable terminal node')
  })

  it('requires loopBound on cyclic transitions and accepts bounded cycles', () => {
    const cyclic: WorkflowGraph = {
      name: 'loop',
      entry: 'a',
      nodes: [node('a'), node('b'), node('end', 'terminal')],
      transitions: [t('t1', 'a', 'b'), t('back', 'b', 'a'), t('t2', 'b', 'end')],
    }
    const issues = validateGraph(cyclic)
    expect(issues.some((issue) => issue.message.includes('loopBound'))).toBe(true)

    const bounded: WorkflowGraph = {
      ...cyclic,
      transitions: [
        t('t1', 'a', 'b', { loopBound: 3 }),
        t('back', 'b', 'a', { loopBound: 3 }),
        t('t2', 'b', 'end'),
      ],
    }
    expect(validateGraph(bounded)).toEqual([])
  })

  it('rejects terminal nodes with outgoing transitions', () => {
    const issues = validateGraph({
      name: 'bad',
      entry: 'a',
      nodes: [node('a'), node('end', 'terminal')],
      transitions: [t('t1', 'a', 'end'), t('t2', 'end', 'a', { loopBound: 2 })],
    })
    expect(issues.some((issue) => issue.message.includes('terminal node'))).toBe(true)
  })
})

describe('run state machine (phase 2)', () => {
  it('supports the generic WAITING state', () => {
    assertTransition(RunState.Running, RunState.Waiting)
    assertTransition(RunState.Waiting, RunState.Running)
    assertTransition(RunState.Waiting, RunState.WaitingForHuman)
    assertTransition(RunState.WaitingForHuman, RunState.Waiting)
    expect(canTransition(RunState.Queued, RunState.Waiting)).toBe(false)
  })
})

describe('managed work-item section', () => {
  it('appends a managed section without touching human content', () => {
    const result = upsertManagedSection('Human wrote this.', 'status: working')
    expect(result.applied).toBe(true)
    expect(result.body).toContain('Human wrote this.')
    expect(readManagedSection(result.body)).toBe('status: working')
  })

  it('replaces only the managed section on update', () => {
    const first = upsertManagedSection('Intro.\n\nOutro after.', 'v1')
    const second = upsertManagedSection(first.body, 'v2')
    expect(second.body).toContain('Intro.')
    expect(second.body).toContain('Outro after.')
    expect(readManagedSection(second.body)).toBe('v2')
    expect(second.body.split(MANAGED_SECTION_BEGIN)).toHaveLength(2)
  })

  it('refuses to modify a body with damaged delimiters', () => {
    const damaged = `text ${MANAGED_SECTION_END} only end marker`
    const result = upsertManagedSection(damaged, 'new')
    expect(result.applied).toBe(false)
    expect(result.body).toBe(damaged)
  })
})

describe('mapping rules', () => {
  const item: WorkItem = {
    id: asId('fake:X-1'),
    provider: 'fake',
    externalId: 'X-1',
    title: 'Fix mobile login',
    state: 'Ready',
    type: 'bug',
    labels: ['mobile', 'auth'],
    assignees: [],
    relationships: [{ kind: 'parent-of', targetExternalId: 'X-2' }],
    metadata: { team: 'identity' },
  }

  it('evaluates predicates with and/or/not and field paths', () => {
    expect(
      evaluatePredicate(
        {
          all: [
            { condition: { field: 'type', operator: 'equals', value: 'bug' } },
            { condition: { field: 'labels', operator: 'in', value: ['mobile', 'web'] } },
            { not: { condition: { field: 'state', operator: 'equals', value: 'Done' } } },
            { condition: { field: 'metadata.team', operator: 'regex', value: '^ident' } },
            { condition: { field: 'title', operator: 'contains', value: 'LOGIN' } },
          ],
        },
        item,
      ),
    ).toBe(true)
  })

  it('resolves repositories with priority, merge, and replace semantics', () => {
    const rules: MappingRuleSet = {
      name: 'default',
      rules: [
        {
          id: 'low-docs',
          priority: 1,
          when: { condition: { field: 'provider', operator: 'equals', value: 'fake' } },
          repositories: [{ repository: { locator: 'org/docs' }, role: 'docs' }],
        },
        {
          id: 'mobile',
          priority: 10,
          when: { condition: { field: 'labels', operator: 'in', value: ['mobile'] } },
          repositories: [
            { repository: { locator: 'org/app-ios' }, role: 'primary' },
            { repository: { locator: 'org/api' }, role: 'backend' },
          ],
        },
      ],
    }
    const resolved = resolveRepositories(rules, item)
    expect(resolved.map((entry) => entry.repository.locator).sort()).toEqual([
      'org/api',
      'org/app-ios',
      'org/docs',
    ])
    expect(resolved.find((entry) => entry.repository.locator === 'org/app-ios')?.resolvedBy).toBe(
      'rule:mobile',
    )

    const withReplace: MappingRuleSet = {
      name: 'replace',
      rules: [
        ...rules.rules.map((rule) =>
          rule.id === 'mobile' ? { ...rule, onConflict: 'replace' as const } : rule,
        ),
      ],
    }
    const replaced = resolveRepositories(withReplace, item)
    expect(replaced.map((entry) => entry.repository.locator).sort()).toEqual([
      'org/api',
      'org/app-ios',
    ])
  })
})

describe('instruction merge', () => {
  const doc = (path: string, precedence: number, size = 10): InstructionDocument => ({
    source: 'CLAUDE.md',
    scope: 'repository',
    path,
    content: 'x'.repeat(size),
    contentHash: path,
    precedence,
    providerId: 'test',
  })

  it('dedupes by path and orders ascending by precedence', () => {
    const merged = mergeInstructions([doc('/a', 1), doc('/b', 5), doc('/a', 9)])
    expect(merged.documents.map((d) => d.path)).toEqual(['/b', '/a'])
    expect(merged.documents[1]?.precedence).toBe(9)
  })

  it('drops lowest-precedence documents beyond the budget', () => {
    const merged = mergeInstructions([doc('/low', 1, 50), doc('/high', 9, 50)], {
      maxTotalChars: 60,
    })
    expect(merged.documents.map((d) => d.path)).toEqual(['/high'])
    expect(merged.excluded[0]?.document.path).toBe('/low')
  })
})

describe('context assembly', () => {
  it('includes by priority under budget and records exclusions', () => {
    const fragment = (id: string, priority: number, size: number) => ({
      resolverId: id,
      kind: 'test',
      title: id,
      content: 'x'.repeat(size),
      priority,
      provenance: id,
    })
    const bundle = assembleContext(
      [fragment('low', 1, 40), fragment('high', 9, 40), fragment('mid', 5, 40)],
      90,
    )
    expect(bundle.fragments.map((f) => f.title)).toEqual(['high', 'mid'])
    expect(bundle.excluded[0]?.fragment.title).toBe('low')
  })
})

describe('gate composition', () => {
  it('flattens bases first and dedupes by gate id', () => {
    const base: GateSet = {
      name: 'base',
      gates: [
        { id: 'tests-pass', description: '', kind: 'deterministic', check: 'true', required: true },
      ],
    }
    const extended: GateSet = {
      name: 'ext',
      extends: ['base'],
      gates: [
        {
          id: 'tests-pass',
          description: 'override ignored',
          kind: 'agent',
          check: 'x',
          required: true,
        },
        { id: 'reviewed', description: '', kind: 'human', check: 'approve?', required: true },
      ],
    }
    const gates = composeGateSets(extended, [base])
    expect(gates.map((gate) => gate.id)).toEqual(['tests-pass', 'reviewed'])
    expect(gates[0]?.kind).toBe('deterministic')
  })
})

describe('profile composition', () => {
  it('applies fragments in order with scalar override and union semantics', () => {
    const resolved = composeProfile(
      {
        name: 'coder',
        compose: ['base'],
        fragment: {
          primary: { executor: 'native-anthropic', model: 'strong' },
          toolNames: ['edit_file'],
          systemPrompt: 'Be precise.',
        },
      },
      [
        {
          primary: { executor: 'native-openai' },
          toolNames: ['read_file'],
          systemPrompt: 'Base rules.',
          permissions: [{ id: 'p1', capability: 'filesystem.read', effect: 'allow' }],
        },
      ],
      ['base'],
    )
    expect(resolved.primary.executor).toBe('native-anthropic')
    expect(resolved.toolNames).toEqual(['read_file', 'edit_file'])
    expect(resolved.systemPrompt).toBe('Base rules.\n\nBe precise.')
    expect(resolved.permissions).toHaveLength(1)
    expect(resolved.composedFrom).toEqual(['base', 'coder'])
  })

  it('fails composition without a primary selection', () => {
    expect(() => composeProfile({ name: 'empty', fragment: {} }, [], [])).toThrow(
      ProfileCompositionError,
    )
  })
})

describe('rubric scoring', () => {
  const rubric: EvaluationRubric = {
    name: 'r',
    criteria: [
      { id: 'impact', description: '', weight: 3 },
      { id: 'effort', description: '', weight: 1 },
    ],
    killCriteria: [],
    advanceThreshold: 6,
  }

  it('computes the weighted score', () => {
    const score = weightedScore(rubric, [
      { criterionId: 'impact', score: 8, reason: '' },
      { criterionId: 'effort', score: 4, reason: '' },
    ])
    expect(score).toBe(7)
  })

  it('treats missing criterion scores as zero', () => {
    expect(weightedScore(rubric, [{ criterionId: 'impact', score: 8, reason: '' }])).toBe(6)
  })
})

describe('human input validation', () => {
  it('validates each request type', () => {
    validateHumanInputValue({ type: 'text', prompt: '', surface: 'app' }, 'hello')
    validateHumanInputValue({ type: 'approval', prompt: '', surface: 'both' }, true)
    validateHumanInputValue(
      { type: 'single-choice', prompt: '', surface: 'app', choices: ['a', 'b'] },
      'a',
    )
    validateHumanInputValue(
      { type: 'multiple-choice', prompt: '', surface: 'app', choices: ['a', 'b'] },
      ['a', 'b'],
    )
    expect(() =>
      validateHumanInputValue({ type: 'boolean', prompt: '', surface: 'app' }, 'yes'),
    ).toThrow(InputValidationFailure)
    expect(() =>
      validateHumanInputValue(
        { type: 'single-choice', prompt: '', surface: 'app', choices: ['a'] },
        'z',
      ),
    ).toThrow(InputValidationFailure)
    expect(() => validateHumanInputValue({ type: 'text', prompt: '', surface: 'app' }, '')).toThrow(
      InputValidationFailure,
    )
  })
})

describe('definitions', () => {
  it('canonicalizes documents independent of key order', () => {
    expect(canonicalizeDocument({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      canonicalizeDocument({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    )
  })
})

describe('execution specifications', () => {
  const spec = (goal: string): ExecutionSpecification => ({
    runId: asId('r1'),
    revision: 1,
    createdAt: new Date(),
    reason: 'initial',
    goal,
    acceptanceCriteria: [],
    workItemId: 'w1',
    relatedWorkItemIds: [],
    repositories: [],
    instructions: [],
    promotedContext: [],
    snapshotId: 's1',
    completionCriteria: [],
    metadata: {},
  })

  it('detects material differences and ignores bookkeeping', () => {
    expect(specsMateriallyDiffer(spec('a'), spec('a'))).toBe(false)
    expect(specsMateriallyDiffer(spec('a'), spec('b'))).toBe(true)
    expect(specsMateriallyDiffer(spec('a'), { ...spec('a'), revision: 7, reason: 'resume' })).toBe(
      false,
    )
  })
})
