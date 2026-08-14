/**
 * Built-in workflow definitions shipped with Overture. Kept as raw YAML
 * (rather than hand-built `WorkflowDefinition` objects) so they exercise the
 * same parser/validator path as user-authored workflows.
 *
 * Pattern: when-gates choose whether to run; assert-gates decide success —
 * gate delivery on an assert, not a when. A `when`-false skip is always
 * benign (see engine.ts), so nothing gated purely behind `when` can ever
 * fail a workflow, no matter what the expression checks. `remediate` and
 * `re_review` below are legitimately `when`-gated (they're optional work:
 * skip them when there's nothing to do). But whether the change is actually
 * fit to deliver must be decided by a step that runs unconditionally and can
 * genuinely fail — `ensure_validated` (a `workflow.assert` action step,
 * `when: 'true'`) is that step: it throws (a real failure) unless review
 * passed directly or remediation fixed it, and `deliver`'s plain
 * `depends_on: [ensure_validated]` (no `when`) lets that real failure taint
 * it. The default workflow runs unattended end to end; a human approval gate
 * is an opt-in a user can add to their own workflow, not baked in here.
 */

export const softwareDevelopmentWorkflowYaml = `
name: software-development
description: >-
  Default end-to-end workflow: an agent plans the change, implements it, runs
  the test suite, and a reviewer either clears it for delivery or sends it
  back for remediation. Delivery only proceeds once review or remediation has
  actually succeeded; a pull request is opened unattended, no human approval
  required.

trigger:
  states: [Ready for Agent]

eligibility:
  labels:
    include: [agent-ready]
    exclude: [blocked]
  types: [bug, feature, chore]

workspace:
  strategy: git-worktree
  retention: on-failure

budget: default

steps:
  - id: analyze
    agent: planner
    goal: >-
      Read the linked work item and the surrounding repository context, then
      produce a concise implementation plan: the files to touch, the
      approach, and the acceptance criteria this change must satisfy.
      Output a \`title\` suitable for a pull request and a \`plan\` summary
      as step outputs.
    route: planner
    max_turns: 20

  - id: implement
    agent: coder
    depends_on: [analyze]
    goal: >-
      Implement the plan produced by the analyze step. Make the smallest
      correct change that satisfies the acceptance criteria, following the
      repository's existing conventions. Commit the work using the
      Conventional Commits specification.
    route: coder
    max_turns: 40

  - id: test
    # Deliberately a literal, not \${{ vars.test_command }}: command steps
    # resolve \${{ }} via env-var indirection for injection safety (see
    # engine.ts / expressions.ts interpolateForShell), which quotes every
    # substituted value as a single token — a variable meant to expand into
    # multiple words (e.g. "npm test" splitting into a command + an arg)
    # would no longer word-split. Fork this workflow and edit the literal
    # command directly to use a different test runner.
    command: npm test
    depends_on: [implement]
    timeout: 10m
    retry:
      max_attempts: 2
      backoff: 5s

  - id: review
    agent: reviewer
    depends_on: [implement, test]
    goal: >-
      Review the implemented change against the plan and acceptance
      criteria. Check correctness, test coverage, and adherence to
      repository conventions. Report pass/fail and, on failure, the specific
      issues that must be fixed.
    route: reviewer
    max_turns: 15

  - id: remediate
    agent: coder
    when: steps.review.failed
    depends_on: [review]
    goal: >-
      Address every issue raised in the review. Re-run the test command
      after making changes and ensure it passes before finishing.
    route: coder
    max_turns: 30

  - id: re_review
    agent: reviewer
    when: steps.remediate.succeeded
    depends_on: [remediate]
    goal: >-
      Re-review the remediated change against the original review findings
      and acceptance criteria. Report pass/fail.
    route: reviewer
    max_turns: 15

  - id: ensure_validated
    action: workflow.assert
    # Always eligible once review and any remediation attempt have settled
    # (depends_on still drives that ordering). The assert itself — a real
    # step failure when its condition isn't 'true' — is what must carry a
    # genuine "neither review nor remediation succeeded" outcome; a
    # when-false skip can never fail a workflow (see engine.ts), so this
    # can't be expressed as a when-gate on deliver.
    when: 'true'
    depends_on: [review, re_review]
    with:
      condition: '\${{ steps.review.succeeded || steps.re_review.succeeded }}'
      message: 'neither review nor re-review succeeded'

  - id: deliver
    action: source_control.pull_request
    depends_on: [ensure_validated]
    with:
      title: '\${{ steps.analyze.outputs.title }}'
      body: '\${{ steps.analyze.outputs.plan }}'

transitions:
  success: Done
  failure: Agent Failed
  blocked: Needs Attention
`
