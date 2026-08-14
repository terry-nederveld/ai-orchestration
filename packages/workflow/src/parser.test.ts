import { describe, expect, it } from 'vitest'
import { WorkflowValidationError } from './errors.js'
import { parseWorkflowYaml } from './parser.js'

const FULL_WORKFLOW_YAML = `
name: software-development
description: Plan, implement, test, review.
trigger:
  states: [Ready for Agent]
eligibility:
  labels:
    include: [agent-ready]
    exclude: [blocked]
  types: [bug, feature]
  assignee: unassigned
workspace:
  strategy: git-worktree
  retention: on-failure
variables:
  test_command: npm test
budget: default
steps:
  - id: analyze
    agent: planner
    goal: Produce an implementation plan.
    route: planner
    max_turns: 20
  - id: implement
    agent: coder
    depends_on: [analyze]
    goal: Implement the plan.
  - id: test
    command: \${{ vars.test_command }}
    depends_on: [implement]
    timeout: 10m
    retry:
      max_attempts: 2
      backoff: 5s
  - id: review
    agent: reviewer
    depends_on: [implement, test]
    goal: Review the change.
  - id: remediate
    agent: coder
    when: steps.review.failed
    depends_on: [review]
    goal: Fix the issues raised in review.
  - id: approve_delivery
    approval: Confirm PR creation
    depends_on: [review]
    when: steps.review.succeeded
  - id: deliver
    action: source_control.pull_request
    depends_on: [approve_delivery]
    with:
      title: '\${{ steps.analyze.outputs.title }}'
transitions:
  success: Done
  failure: Agent Failed
  blocked: Needs Attention
`

describe('parseWorkflowYaml (happy path)', () => {
  const definition = parseWorkflowYaml(FULL_WORKFLOW_YAML, 'full.yaml')

  it('maps top-level fields', () => {
    expect(definition.name).toBe('software-development')
    expect(definition.description).toBe('Plan, implement, test, review.')
    expect(definition.budget).toBe('default')
    expect(definition.variables).toEqual({ test_command: 'npm test' })
    expect(definition.trigger).toEqual({ states: ['Ready for Agent'] })
    expect(definition.workspace).toEqual({ strategy: 'git-worktree', retention: 'on-failure' })
    expect(definition.transitions).toEqual({
      success: 'Done',
      failure: 'Agent Failed',
      blocked: 'Needs Attention',
    })
  })

  it('maps eligibility from nested labels.include/exclude to flat labelsInclude/labelsExclude', () => {
    expect(definition.eligibility).toEqual({
      labelsInclude: ['agent-ready'],
      labelsExclude: ['blocked'],
      types: ['bug', 'feature'],
      assignee: 'unassigned',
    })
  })

  it('maps an agent step, including camelCase field names', () => {
    const analyze = definition.steps.find((s) => s.id === 'analyze')
    expect(analyze).toMatchObject({
      kind: 'agent',
      agent: 'planner',
      goal: 'Produce an implementation plan.',
      route: 'planner',
      maxTurns: 20,
    })
  })

  it('maps a command step, converting timeout/backoff durations to milliseconds', () => {
    const test = definition.steps.find((s) => s.id === 'test')
    expect(test).toMatchObject({
      kind: 'command',
      dependsOn: ['implement'],
      timeoutMs: 10 * 60 * 1000,
      retry: { maxAttempts: 2, backoffMs: 5_000 },
    })
  })

  it('does not interpolate ${{ }} references at parse time — that is left for the engine', () => {
    const test = definition.steps.find((s) => s.id === 'test')
    expect(test?.kind === 'command' && test.command).toBe('${{ vars.test_command }}')
  })

  it('maps an action step with `with` args', () => {
    const deliver = definition.steps.find((s) => s.id === 'deliver')
    expect(deliver).toMatchObject({
      kind: 'action',
      action: 'source_control.pull_request',
      dependsOn: ['approve_delivery'],
      with: { title: '${{ steps.analyze.outputs.title }}' },
    })
  })

  it('maps an approval step, using the `approval` field as the description', () => {
    const approve = definition.steps.find((s) => s.id === 'approve_delivery')
    expect(approve).toMatchObject({
      kind: 'approval',
      description: 'Confirm PR creation',
      when: 'steps.review.succeeded',
    })
  })

  it('preserves the when expression on a remediation step', () => {
    const remediate = definition.steps.find((s) => s.id === 'remediate')
    expect(remediate?.when).toBe('steps.review.failed')
  })
})

describe('parseWorkflowYaml (validation)', () => {
  function issuesOf(yaml: string): readonly { path: string; message: string }[] {
    try {
      parseWorkflowYaml(yaml, 'doc.yaml')
      throw new Error('expected parseWorkflowYaml to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError)
      return (error as WorkflowValidationError).issues
    }
  }

  it('rejects malformed YAML', () => {
    const issues = issuesOf('name: [unterminated')
    expect(issues[0]?.message).toMatch(/invalid YAML/)
  })

  it('rejects an unknown top-level field (strict schema)', () => {
    const issues = issuesOf(`
name: w
steps: [{ id: a, command: echo hi }]
bogus_field: nope
`)
    expect(
      issues.some(
        (i) => /bogus_field|unrecognized/i.test(i.message) || i.path.includes('bogus_field'),
      ),
    ).toBe(true)
  })

  it('reports duplicate step ids with both locations', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo 1
  - id: a
    command: echo 2
`)
    const duplicate = issues.find((i) => i.path === 'steps[1].id')
    expect(duplicate?.message).toMatch(/duplicate step id 'a'/)
  })

  it('reports depends_on referencing an unknown step', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo 1
    depends_on: [missing]
`)
    const issue = issues.find((i) => i.path === 'steps[0].depends_on[0]')
    expect(issue?.message).toMatch(/unknown step 'missing'/)
  })

  it('reports a dependency cycle', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo 1
    depends_on: [b]
  - id: b
    command: echo 2
    depends_on: [a]
`)
    const issue = issues.find((i) => i.path === 'steps')
    expect(issue?.message).toMatch(/dependency cycle detected: a -> b -> a/)
  })

  it('reports an invalid when expression', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo 1
    when: "steps.a ==="
`)
    const issue = issues.find((i) => i.path === 'steps[0].when')
    expect(issue?.message).toMatch(/invalid when expression/)
  })

  it('reports a missing goal on an agent step', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    agent: coder
`)
    const issue = issues.find((i) => i.path === 'steps[0].goal')
    expect(issue?.message).toMatch(/require a non-empty goal/)
  })

  it('reports a step declaring zero kinds', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    depends_on: []
`)
    const issue = issues.find((i) => i.path === 'steps[0]')
    expect(issue?.message).toMatch(/exactly one of/)
  })

  it('reports a step declaring multiple kinds', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo hi
    action: source_control.pull_request
`)
    const issue = issues.find((i) => i.path === 'steps[0]')
    expect(issue?.message).toMatch(/declares multiple kinds/)
  })

  it('collects every problem in a single document, not just the first', () => {
    const issues = issuesOf(`
name: w
steps:
  - id: a
    command: echo 1
  - id: a
    command: echo 2
    depends_on: [missing]
    when: "steps.a ==="
`)
    expect(issues.length).toBeGreaterThanOrEqual(3)
    expect(issues.some((i) => i.path === 'steps[1].id')).toBe(true)
    expect(issues.some((i) => i.path === 'steps[1].depends_on[0]')).toBe(true)
    expect(issues.some((i) => i.path === 'steps[1].when')).toBe(true)
  })
})
