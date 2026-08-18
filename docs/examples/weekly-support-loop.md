# Example: recurring weekly support loop

A scheduled workflow (same engine, same definitions) that runs every Monday
morning: collect support evidence, cluster pain points, correlate against
prior work, apply the right disposition per cluster, and emit agent-ready
stories that Autonomous Delivery can pick up.

Install both documents with the control plane (`PUT
/api/definitions/schedule/weekly-support-loop` and `PUT
/api/definitions/workflow/weekly-support-analysis`), then enable them
(`overture definitions enable schedule weekly-support-loop`, `overture
definitions enable workflow weekly-support-analysis`). The daemon fires due
schedules on its poll interval and persists each firing, so restarts never
double-run a week.

## Schedule

```yaml
# kind: schedule
name: weekly-support-loop
description: Monday 09:00 UTC support analysis over the connected backlog.
cron: "0 9 * * 1"
workflow: weekly-support-analysis
payload:
  window_days: 7
enabled: true
```

## Workflow

The correlate step must distinguish unresolved work, unreleased fixes,
regressions, and genuinely new issues; the apply step turns each cluster's
disposition into the matching work-item operation (`create`, `update`,
`append-evidence`, `ignore`, or `create-regression` linked to the prior
item).

```yaml
# kind: workflow
name: weekly-support-analysis
description: Collect, cluster, correlate, and disposition support evidence.
entry: collect
defaultProfile:
  name: discovery-default
nodes:
  - id: collect
    config:
      kind: agent
      goal: >-
        Collect support evidence from the permitted sources for the last
        window_days days. Return the raw evidence list with provenance.
      outputSchema:
        type: object
        properties:
          evidence:
            type: array
            items:
              type: object
              properties:
                summary: { type: string }
                provenance: { type: string }
        required: [evidence]
  - id: cluster
    config:
      kind: agent
      goal: >-
        Cluster the evidence into distinct pain points. Every cluster keeps
        its supporting evidence references.
      outputSchema:
        type: object
        properties:
          clusters:
            type: array
            items:
              type: object
              properties:
                title: { type: string }
                summary: { type: string }
                evidence: { type: array, items: { type: string } }
        required: [clusters]
  - id: correlate
    config:
      kind: agent
      goal: >-
        Correlate each cluster against existing work items and recent
        deliveries. Distinguish: unresolved work already tracked, a fix that
        is merged but unreleased, a regression of previously delivered work,
        and a genuinely new issue. Choose exactly one disposition per
        cluster: create, update, append-evidence, ignore, or
        create-regression (with the prior item's external id).
      outputSchema:
        type: object
        properties:
          dispositions:
            type: array
            items:
              type: object
              properties:
                title: { type: string }
                description: { type: string }
                disposition:
                  type: string
                  enum: [create, update, append-evidence, ignore, create-regression]
                target_external_id: { type: string }
        required: [dispositions]
  - id: apply
    config:
      kind: fan-out
      items: results.correlate.outputs.dispositions
      workflow:
        name: weekly-support-apply
      join:
        mode: all
  - id: done
    config: { kind: terminal, outcome: completed }
  - id: failed
    config: { kind: terminal, outcome: failed }
transitions:
  - { id: c1, from: collect, to: cluster, condition: "node.status == 'succeeded'" }
  - { id: c2, from: cluster, to: correlate, condition: "node.status == 'succeeded'" }
  - { id: c3, from: correlate, to: apply, condition: "node.status == 'succeeded'" }
  - { id: c4, from: apply, to: done, condition: "node.status == 'succeeded'" }
  - { id: c5, from: apply, to: failed, condition: "node.status == 'failed'" }
```

## Per-cluster apply workflow

Each fan-out branch receives one disposition as `vars.item` and performs the
matching operation with the built-in work actions. Created stories carry the
`agent-ready` label, which is exactly what a delivery lane consumes — so the
loop optionally feeds Autonomous Delivery with no extra glue.

```yaml
# kind: workflow
name: weekly-support-apply
description: Apply one disposition from the weekly support analysis.
entry: route
nodes:
  - id: route
    config: { kind: action, action: workflow.noop }
  - id: create
    config:
      kind: action
      action: work.create_item
      with:
        title: "$expr:vars.item.title"
        description: "$expr:vars.item.description"
        type: story
        labels: [agent-ready, support-loop]
  - id: append
    config:
      kind: action
      action: work.comment
      with:
        body: "$expr:vars.item.description"
  - id: done
    config: { kind: terminal, outcome: completed }
transitions:
  - { id: r-create, from: route, to: create, condition: "vars.item.disposition == 'create' || vars.item.disposition == 'create-regression'" }
  - { id: r-append, from: route, to: append, condition: "vars.item.disposition == 'update' || vars.item.disposition == 'append-evidence'" }
  - { id: r-ignore, from: route, to: done, condition: "vars.item.disposition == 'ignore'" }
  - { id: a-done, from: create, to: done, condition: "node.status == 'succeeded'" }
  - { id: b-done, from: append, to: done, condition: "node.status == 'succeeded'" }
```

## Lane pairing

To keep the created stories flowing into delivery on backlog rank without
manual triage, pair the loop with a lane:

```yaml
# kind: lane
name: support-delivery
source: github-main
query: { labelsInclude: [agent-ready, support-loop] }
workflow: autonomous-delivery
policy: skip_blocked
maxActive: 2
enabled: true
```
