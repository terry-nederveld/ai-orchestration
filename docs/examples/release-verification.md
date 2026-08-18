# Example: continuing delivery through release verification

The release/deployment lifecycle is represented by the stages in
`@overture/core`'s release model — `implemented`, `pr-opened`, `merged`,
`released`, `deployed`, `verified` — folded monotonically from
`ReleaseSignal`s that adapters or extensions derive from the systems they
integrate (SCM merge status, CI/CD deployments, issue fields) through the
`ReleaseSignalSource` port. Progress is sparse by design: only the stages
the connected systems can actually report are recorded, each with its first
signal as evidence.

A workflow may optionally continue past merge. Post-merge stages are
`external-event` waits — durable, checkpointed, satisfiable days later —
keyed `release:<stage>` so a signal source (or a human via the waits API)
can satisfy them:

```yaml
# kind: workflow
name: delivery-with-verification
description: Implement, deliver, then follow the change to verified.
entry: implement
defaultProfile:
  name: delivery-default
workspace: { strategy: git-worktree, retention: on-failure }
nodes:
  - id: implement
    config:
      kind: subworkflow
      workflow: { name: autonomous-delivery }
  - id: wait_merged
    config:
      kind: wait
      condition:
        kind: external-event
        parameters: { event: "release:merged" }
  - id: deploy
    config:
      kind: command
      command: npm run deploy:staging
      timeoutMs: 900000
  - id: wait_deployed
    config:
      kind: wait
      condition:
        kind: external-event
        parameters: { event: "release:deployed" }
  - id: observe
    config:
      kind: wait
      condition:
        kind: time
        parameters: { durationMs: 3600000 }
  - id: verify
    config:
      kind: agent
      goal: >-
        Verify the deployed change against its acceptance criteria using the
        permitted observability sources. Report pass or fail with evidence.
      outputSchema:
        type: object
        properties:
          passed: { type: boolean }
          evidence: { type: array, items: { type: string } }
        required: [passed]
  - id: done
    config: { kind: terminal, outcome: completed }
  - id: failed
    config: { kind: terminal, outcome: failed }
transitions:
  - { id: t1, from: implement, to: wait_merged, condition: "node.status == 'succeeded'" }
  - { id: t2, from: wait_merged, to: deploy, condition: "node.status == 'succeeded'" }
  - { id: t3, from: deploy, to: wait_deployed, condition: "node.status == 'succeeded'" }
  - { id: t4, from: wait_deployed, to: observe, condition: "node.status == 'succeeded'" }
  - { id: t5, from: observe, to: verify, condition: "node.status == 'succeeded'" }
  - { id: t6, from: verify, to: done, condition: "outputs.passed == true" }
  - { id: t7, from: verify, to: failed, condition: "outputs.passed == false" }
```

Notes:

- Every wait here survives daemon restarts: the run is `WAITING` with a
  persisted `WaitCondition`, and satisfaction (a webhook-driven extension, a
  polling `ReleaseSignalSource`, or `overture waits respond`) resumes it
  with a fresh execution-specification reconciliation.
- The deploy command is a literal, never interpolated (ADR-0016). Fork the
  workflow to change it.
- Release stages reached along the way are ordinary domain observability:
  fold signals with `advanceReleaseProgress` and project them onto the work
  item (comment or managed section) as the operator prefers.
