/**
 * Built-in workflow definitions shipped with Overture. Kept as raw YAML
 * (rather than hand-built `WorkflowDefinition` objects) so they exercise the
 * same parser/validator path as user-authored workflows.
 */

export const softwareDevelopmentWorkflowYaml = `
name: software-development
description: >-
  Default end-to-end workflow: an agent plans the change, implements it, runs
  the test suite, and a reviewer either approves delivery or sends the change
  back for remediation before a pull request is opened.

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

variables:
  test_command: npm test

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
    command: \${{ vars.test_command }}
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

  - id: approve_delivery
    approval: >-
      Confirm this change is ready to open as a pull request. Approve only if
      review passed directly or remediation resolved every issue review
      raised; reject otherwise.
    depends_on: [review, re_review]
    # Always eligible once review and any remediation attempt have settled
    # (depends_on still drives that ordering) — the approval decision itself,
    # not a when gate, is what must carry a genuine "neither review nor
    # remediation succeeded" outcome. A when-false skip can never fail a
    # workflow (see engine.ts), so the step that decides delivery has to
    # actually run and really fail when nothing worked, rather than being
    # skipped past.
    when: 'true'

  - id: deliver
    action: source_control.pull_request
    depends_on: [approve_delivery]
    with:
      title: '\${{ steps.analyze.outputs.title }}'
      body: '\${{ steps.analyze.outputs.plan }}'

transitions:
  success: Done
  failure: Agent Failed
  blocked: Needs Attention
`
