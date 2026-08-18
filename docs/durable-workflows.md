# Durable Graph Workflows

Phase 2 adds a second workflow model alongside the v1 step DAG
([workflows.md](workflows.md)): a durable, typed **graph** of nodes and
declared transitions, executed as a resumable reducer that persists its
state after every node settlement. A graph run can loop (boundedly), fan
out into child runs, suspend on a wait for days, survive daemon restarts,
and resume from its exact position. Agents reason *inside* nodes and
return structured outputs; the engine — never a model — evaluates
conditions and selects among the transitions the author declared
([adr-0017](adrs/adr-0017.md)).

Implementation map:

- Model and validation — `packages/core/src/graph.ts`,
  `graph-validate.ts`, `run-graph.ts`, `waits.ts`, `definitions.ts`,
  `execution-spec.ts`, `checkpoints.ts`, `gates.ts`, `profiles.ts`,
  `experiments.ts`, `lanes.ts`, `mapping.ts`, `release.ts`.
- Engine — `packages/workflow/src/graph-engine/` (`engine.ts` the tick
  reducer, `scope-expr.ts` the expression language, `compile.ts` the
  v1 → graph compiler).
- Orchestration — `packages/orchestrator/src/graph/` (`coordinator.ts`,
  `node-executors.ts`, `snapshot.ts`, `spec-builder.ts`, `evaluate.ts`,
  `experiment-stepper.ts`) and `packages/orchestrator/src/scheduling/`
  (`graph-scheduler.ts`, `routing.ts`).
- Supporting packages — `packages/checkpoints`, `packages/resolution`,
  `packages/experiments`, `packages/templates`.
- Control plane — `packages/server/src/service.ts` + `http.ts`; CLI
  commands in `packages/cli/src/main.ts`; daemon wiring in
  `packages/cli/src/daemon.ts`.

Graph workflows are not YAML files in `.overture/` — they are **versioned
definitions** stored in the definition store (see
[Versioning](#versioning-definitions-lifecycle-snapshots)), installed via
the control plane (`PUT /api/definitions/workflow/<name>` with the
document as JSON) or shipped as templates. The YAML in this page is the
canonical document shape; the API accepts the same structure as JSON.

In the shipped daemon today, graph runs start through **schedules**
(see [Lanes and schedules](#lanes-and-schedules)) or programmatically
via `GraphRunCoordinator.start`; the poll-based scheduler's automatic
dispatch (`overture run`, `POST /api/runs`) still targets v1
workflows. Everything else on this page — waits, checkpoints, gates,
experiments, the control-plane and CLI surfaces — operates on graph
runs however they were started.

## The four state layers

ADR-0017's central discipline: four kinds of state, never conflated.

1. **Graph position** — which nodes are active, waiting, or settled;
   structured outputs per node; loop counters; join accounting; fan-out
   branch progress. Persisted as `RunGraphState`
   (`packages/core/src/run-graph.ts`) after every tick.
2. **Engine run lifecycle** — the closed run state machine
   (QUEUED → PREPARING → RUNNING → WAITING / WAITING_FOR_HUMAN →
   COMPLETED / FAILED / BLOCKED / CANCELLED). The coordinator drives it;
   graph authors never touch it.
3. **User domain state** — an open, author-defined string
   (`setDomainState`) plus a data bag (`setData`), changed only by
   declared lifecycle effects, never by the engine's own semantics.
4. **External projection** — a configurable mapping of internal state
   onto the external work item (states, comments, a managed body
   section). Internal state is authoritative; a projection failure is
   logged and never corrupts the run
   (`GraphRunCoordinator.applyProjections`).

## Graph structure

A workflow graph document (`WorkflowGraph`, `packages/core/src/graph.ts`):

```yaml
name: my-workflow
description: Optional prose.
entry: first_node            # id of the entry node
defaultProfile: { name: delivery-default }   # agent-profile definition ref
workspace:                   # optional; omit (or strategy: none) for non-code runs
  strategy: git-worktree
  retention: on-failure      # always | on-failure | never
domainStates: [triaging, fixing, done]   # declared for validation/UI; open set
variables:
  environment: production
projection:
  states: { fixing: 'In Progress', done: 'Done' }  # domain/engine state → external state
  comments: [waiting, resumed, checkpoint]         # engine events worth a work-item comment
  managedSection: true       # keep a managed section of the item body updated
nodes: [ ... ]
transitions: [ ... ]
```

At run start the coordinator injects `vars.work_title` and `vars.work_id`
on top of `variables` and any per-start overrides
(`GraphRunCoordinator.start`, `packages/orchestrator/src/graph/coordinator.ts`).

### Nodes

Every node has an `id`, a kind-discriminated `config`, and optionally:

```yaml
- id: fix
  config: { ... }            # one of the ten kinds below
  join: { mode: all }        # activation rule for multiple incoming transitions
  guards: ["vars.environment == 'production'"]  # all must be true, else the node fails
  onEnter: { setDomainState: fixing }
  onExit:  { setData: { last_error: node.error } }
  retry: { maxAttempts: 2, backoffMs: 5000 }
```

`guards` are evaluated before the executor runs; a false or erroring
guard fails the node. `retry` re-activates a failed node up to
`maxAttempts` total attempts *before* transitions see the failure
(`packages/workflow/src/graph-engine/engine.ts`).

### Node kinds

Ten kinds (`GraphNodeKind`, `packages/core/src/graph.ts`); executors bind
them to the real world in
`packages/orchestrator/src/graph/node-executors.ts`.

**`agent`** — an agent session pursuing a goal, executed through a
snapshot-pinned profile (see [Profiles](#profiles-and-fallback)).

```yaml
config:
  kind: agent
  goal: Implement the planned change completely.
  profile: { name: delivery-default }   # optional; falls back to the workflow defaultProfile
  outputSchema:                          # optional JSON schema for structured outputs
    type: object
    properties: { approved: { type: boolean } }
    required: [approved]
  toolNames: [read_file, edit_file]      # optional allowlist
  maxTurns: 40
  timeoutMs: 900000
```

With an `outputSchema`, the agent's final report must be a single JSON
object conforming to it; the executor parses it and the object becomes
the node's `outputs` (plus `outputs.summary`, the raw report). An agent
that completes without the required structured output fails the node. An
agent that ends with `HUMAN_INPUT_REQUIRED` suspends the node on a
durable free-form human-input wait; the eventual response is appended to
the agent's context and the node re-executes.

**`command`** — a shell command in the run's workspace (required; a
command node in a workspace-less run fails). Exit 0 succeeds. Outputs:
`exitCode`, `output`.

```yaml
config: { kind: command, command: npm test, cwd: web, timeoutMs: 900000 }
```

Command strings are literals — never interpolated (a security decision,
[adr-0016](adrs/adr-0016.md)); fork the workflow to change a command.

**`action`** — a registered `WorkflowAction`
(`packages/orchestrator/src/actions.ts`: `workflow.assert`,
`source_control.commit`/`push`/`pull_request`, `work.comment`,
`work.create_item`, `work.update_section`, `work.transition`, plus
extension-contributed actions).

```yaml
config:
  kind: action
  action: work.update_section
  with:
    content: "$expr:results.prd.outputs.prd_markdown"
```

String arguments prefixed `$expr:` are evaluated against the run scope
(`vars`, `domain`, `results`) — an explicit, deterministic opt-in; other
values pass through untouched. Nothing is ever shell-interpolated.

**`gate`** — evaluates a versioned gate set (Definition of Ready/Done);
see [Gates](#gates-definition-of-ready-and-done).

```yaml
config:
  kind: gate
  gateSet: { name: delivery-definition-of-ready }
  maxRemediationAttempts: 1        # 0 (default) disables remediation at this node
  remediationProfile: { name: fixer }   # optional; also used for agent-kind gates
```

**`human-input`** — asks a typed question and suspends durably until a
valid answer arrives; see
[Durable waits and human input](#durable-waits-and-human-input). Output:
`value` (the typed response).

```yaml
config:
  kind: human-input
  request:
    type: approval        # text | boolean | single-choice | multiple-choice |
                          # approval | secret | file-reference | free-form
    prompt: Approve creation of the related stories?
    surface: both         # app | work_item | both
    choices: [a, b]       # single-/multiple-choice only
    timeoutMs: 86400000   # optional; becomes the wait's due time
```

**`wait`** — suspends on a non-human condition
(`WaitSpec`, `packages/core/src/graph.ts`): kinds `time`,
`external-event`, `work-item-event`, `dependency`,
`provider-availability` (and `human-input`/`approval`, normally
expressed via `human-input` nodes). The satisfaction's event payload
becomes the node's outputs.

```yaml
config:
  kind: wait
  condition:
    kind: time
    parameters: { afterMs: 3600000 }   # or: { until: '2026-09-01T09:00:00Z' }
```

Due `time` waits are fired by the daemon's periodic tick
(`GraphRunCoordinator.fireDueTimers`). `external-event` waits are
satisfied through the waits API by whatever observes the event — see
[Release lifecycle](#release-lifecycle) for the `release:<stage>`
convention.

**`subworkflow`** — starts a child run of another workflow definition (at
the version pinned in the snapshot) and suspends on a `dependency` wait
until it settles. `inputs` maps expressions into the child's initial
variables.

```yaml
config:
  kind: subworkflow
  workflow: { name: autonomous-delivery }
  inputs: { parent_goal: results.plan.outputs.approach }
```

**`fan-out`** — evaluates `items` to a list, starts one child run per
item (the item bound as `vars.item`, its index as `vars.branch`), and
suspends until the `join` is decided. An empty list succeeds immediately
with `outputs.branches: []`.

```yaml
config:
  kind: fan-out
  items: results.prd.outputs.story_candidates
  workflow: { name: discovery-create-story }
  join: { mode: all }        # all | any | min (min requires n)
```

**`experiment`** — runs a durable, judgment-gated experiment; see
[Experiments](#experiments).

**`terminal`** — ends the run with `outcome: completed | failed |
blocked`. Terminal nodes must have no outgoing transitions.

### Transitions

```yaml
transitions:
  - id: review-ok
    from: review
    to: dod
    condition: outputs.approved == true
  - id: review-remediate
    from: review
    to: remediate
    condition: outputs.approved == false
    loopBound: 2
    effects: { setDomainState: remediating }
```

When a node settles, its outgoing transitions are evaluated **in
declaration order**; every transition whose condition passes (or that has
none) fires — parallel branches are just multiple firing transitions.
The condition scope is:

- `outputs.<key>` — the settled node's structured outputs
- `node.status` (`'succeeded'` / `'failed'`) and `node.error`
- `domain.name` and `domain.<dataKey>` — the domain state layer
- `vars.<name>` — run variables
- `results.<nodeId>.status` / `.succeeded` / `.failed` /
  `.outputs.<key>` — any previously settled node

A **failed** node whose settlement fires no transition fails the run
("failed with no matching transition") — failure handling must be
declared, not implied. `loopBound` is the transition's maximum firing
count per run; the engine fails the run rather than exceed it.
Validation *requires* a `loopBound` on every transition that
participates in a cycle. `effects` (also available as node
`onEnter`/`onExit`) may set the domain state, merge expression-valued
entries into the domain data bag, and request an external projection
(`project: <target state>`), which the coordinator applies via the work
provider after the tick.

### The expression language

Transitions, guards, gate checks, `$expr:` action arguments, fan-out
`items`, and sub-workflow `inputs` share one safe expression language
(`packages/workflow/src/graph-engine/scope-expr.ts`): dotted references
against the scope, single-quoted strings, numbers, `true`/`false`, `==`,
`!=`, `!`, `&&`, `||`, parentheses. No `eval`, no prototype access,
deterministic. There are no ordering operators (`<`, `>`); design nodes
to emit booleans instead.

### Joins

A node with multiple incoming transitions declares how firings activate
it (`join`; omitting it gives the implicit per-arrival behavior):

- *implicit* (no `join` declared) — one execution per inbound firing,
  whichever transition it arrives through. This is what alternative
  paths (mutually exclusive conditions) and loop re-entries want: a
  remediation node reached first from `review` and again from
  `re_review` executes both times. Parallel branches converging on an
  implicit node each trigger an execution — declare an explicit join to
  coalesce them instead.
- `any` — activates once per arrival *wave* (the maximum cumulative
  firing count of any single incoming transition): a two-branch diamond
  whose branches both complete activates it once, and a loop transition
  firing *again* re-activates it.
- `all` — activates once every distinct incoming transition has fired.
- `min` with `n` — activates once `n` distinct incoming transitions have
  fired.

`all` and `min` joins are forbidden on nodes inside cycles — activation
counting would be ambiguous across loop rounds — and validation rejects
them (`packages/core/src/graph-validate.ts`). The accounting lives in
`joinSatisfied` (`packages/workflow/src/graph-engine/engine.ts`).

### Validation

`validateGraph` (`packages/core/src/graph-validate.ts`) enforces, in
order: unique node/transition ids and referential integrity; the entry
node exists; every node is reachable from the entry; at least one
reachable terminal node exists; terminal nodes have no outgoing
transitions; `all`/`min` joins do not sit inside cycles (`min` requires
`n >= 1`); and every transition on a cycle declares a `loopBound >= 1`.
The same checks run when a workflow document is validated through the
control plane (`POST /api/definitions/validate` — saving via `PUT` does
not validate; validate first) and again, authoritatively, when a
snapshot is resolved at run start
(`packages/orchestrator/src/graph/snapshot.ts`) — an invalid workflow
cannot start.

### A complete example

Passes `validateGraph`; note the fully-bounded cycle and the declared
failure paths:

```yaml
# kind: workflow
name: fix-and-verify
description: Fix with bounded re-verification, then human sign-off.
entry: fix
defaultProfile: { name: delivery-default }
workspace: { strategy: git-worktree, retention: on-failure }
domainStates: [fixing, verifying, awaiting-signoff, done]
projection:
  states: { done: 'Done' }
  comments: [waiting, resumed, checkpoint]
nodes:
  - id: fix
    config:
      kind: agent
      goal: >-
        Diagnose the reported problem, fix the root cause, and add a
        regression test. If tests failed on a previous pass, address the
        failure output before declaring completion.
    onEnter: { setDomainState: fixing }
  - id: verify
    config: { kind: command, command: npm test, timeoutMs: 900000 }
    onEnter: { setDomainState: verifying }
  - id: signoff
    config:
      kind: human-input
      request:
        type: approval
        prompt: Tests pass. Approve delivery of this fix?
        surface: both
    onEnter: { setDomainState: awaiting-signoff }
  - id: done
    config: { kind: terminal, outcome: completed }
  - id: failed
    config: { kind: terminal, outcome: failed }
transitions:
  - { id: f-verify, from: fix,     to: verify,  condition: "node.status == 'succeeded'", loopBound: 3 }
  - { id: f-bad,    from: fix,     to: failed,  condition: "node.status == 'failed'" }
  - { id: v-retry,  from: verify,  to: fix,     condition: "node.status == 'failed'",    loopBound: 2 }
  - { id: v-ok,     from: verify,  to: signoff, condition: "node.status == 'succeeded'" }
  - { id: s-yes,    from: signoff, to: done,    condition: outputs.value == true,
      effects: { setDomainState: done, project: 'Done' } }
  - { id: s-no,     from: signoff, to: failed,  condition: outputs.value == false }
```

### Execution model: ticks

The engine (`packages/workflow/src/graph-engine/engine.ts`) performs no
I/O of its own. One **tick** loads persisted `RunGraphState`, executes
every runnable active node concurrently through injected executors,
settles results, fires transitions, and returns the next state plus any
newly-opened waits and requested projections — the coordinator persists
state after every tick and applies the side effects. A node executor can
yield a **result** (settling the node) or a **wait** (suspending it); a
later tick carrying the wait's satisfaction re-executes the node with
`context.satisfaction` set. A run whose active set drains without
reaching a terminal fails as stalled. This is why a run survives
restarts: on boot the daemon calls `GraphRunCoordinator.recover()`,
which re-drives interrupted RUNNING/PREPARING runs from persisted state
and leaves WAITING runs exactly where they are — their wait conditions
are durable rows, not memory.

## Versioning: definitions, lifecycle, snapshots

Every reusable definition — workflows, gate sets, rubrics, agent
profiles, experiments, templates, mapping rule sets, lanes, schedules —
is stored as an immutable, content-addressed version
(`packages/core/src/definitions.ts`, [adr-0018](adrs/adr-0018.md)).
Saving a document computes the SHA-256 of its canonicalized JSON:
unchanged content returns the existing version; changed content mints
version `latest + 1`. Versions are never edited in place.

Each `(kind, name)` has a lifecycle: **draft** (stored, not startable),
**enabled** (startable), **disabled**. Unversioned references resolve to
the latest version and require the definition to be enabled; an
explicitly version-pinned reference skips the lifecycle check at
resolution time (the pin is the authority), and a running run's
already-resolved snapshot is never re-checked
(`SnapshotResolver.require`,
`packages/orchestrator/src/graph/snapshot.ts`).

```sh
overture definitions list [kind]
overture definitions enable workflow my-workflow
overture definitions disable workflow my-workflow
```

At run start, the `SnapshotResolver`
(`packages/orchestrator/src/graph/snapshot.ts`) walks the root workflow
and collects **every** definition it references — sub-workflows and
fan-out targets recursively, gate sets, rubrics, experiments, agent
profiles and their composition fragments — validating each workflow
graph on the way, and pins exact versions into one immutable
`ResolvedSnapshot`. Ticks, resumes, gates, experiments, and Evaluate
read from the snapshot only: **a run never sees mid-flight edits**.
Enabling a new version affects the next run, never a running one.

## Durable waits and human input

A run that needs outside input does not poll or hold a model session
open. It persists a `WaitCondition` (`packages/core/src/waits.ts`,
[adr-0019](adrs/adr-0019.md)), checkpoints its durable work product,
releases resources, and leaves RUNNING — for WAITING, or
WAITING_FOR_HUMAN when any open wait carries a typed human request.

Human input requests are typed: `text`, `boolean`, `single-choice`,
`multiple-choice`, `approval`, `secret`, `file-reference`, `free-form`.
Responses are validated against the request
(`validateHumanInputValue`): booleans for `boolean`/`approval`,
a listed choice for `single-choice`, a non-empty subset for
`multiple-choice`, non-empty strings otherwise. A `secret` response is
the stored secret's **name**, never its value. Requests declare a
`surface` — `app` (control plane/desktop), `work_item` (a comment on
the item, when the workflow's projection enables comments), or `both`.

**First valid response wins, atomically** (`WaitRepository.trySatisfy`).
Responses that arrive after satisfaction are never discarded and never
auto-applied: they are recorded as **supplemental input**, available as
context and promotable into a later execution-specification revision by
explicit action only.

Answer waits from the CLI or the API:

```sh
overture waits list [--run <id>] [--type <kind>] [--reason <marker>]
overture waits respond <wait-id> --value true --by terry
overture waits respond <wait-id> --value '"advance:cand-3"'
```

`--value` parses as JSON when it can (`true`, `42`, `["a","b"]`) and
falls back to a raw string. The HTTP equivalents are `GET /api/waits`
and `POST /api/waits/<id>/respond` with `{ "value": ..., "respondedBy":
... }`. A response to an already-satisfied wait returns the winner and
is recorded as supplemental.

## Suspension, checkpoints, and the execution specification

Before a run suspends, the coordinator checkpoints its durable work
product ([adr-0020](adrs/adr-0020.md)); model sessions are disposable by
design. Two shipped strategies (`packages/checkpoints/src`), selected in
the daemon by whether the run has a workspace
(`packages/cli/src/daemon.ts`):

- **`git-branch`** (`git-branch-strategy.ts`) — coding runs. Commits
  work-in-progress (only when the tree is dirty, message
  `chore(checkpoint): …`) and pushes the run's branch to origin.
  Restore rebuilds a fresh worktree from the remote branch — on any
  host — and refuses restoration only if the remote branch no longer
  contains the checkpoint commit.
- **`work-item-section`** (`work-item-section-strategy.ts`) — non-code
  runs. Writes a status block into a delimiter-managed section of the
  originating work item's description, preserving every character of
  human content outside the delimiters
  (`upsertManagedSection`, `packages/core/src/checkpoints.ts`). A body
  with damaged delimiters is never overwritten — the refusal is
  recorded and a comment flags it for a human.

Alongside the graph state, every run carries an **execution
specification** (`packages/core/src/execution-spec.ts`): the immutable,
revisioned statement of what the run is doing — goal, acceptance
criteria, work item and its relationships, resolved repositories with
roles and provenance, discovered instruction files with content hashes
and whether each was applied, promoted supplemental context, the
snapshot id, and completion criteria. Revision 1 is built at start by
the `DefaultSpecBuilder`
(`packages/orchestrator/src/graph/spec-builder.ts`) from the work item,
the configured mapping rules (see
[configuration.md](configuration.md#mapping)), and instruction
discovery over the workspace
(`packages/resolution/src/instruction-providers.ts`: CLAUDE.md,
AGENTS.md, AGENT.md, `.github/copilot-instructions.md`; directory scope
outranks repository scope). On every resume the builder runs again
against the now-current external state; if the result **materially
differs** (`specsMateriallyDiffer`), revision N+1 is appended — history
is preserved, and the run's graph state records which revision it
operates under.

## Gates: Definition of Ready and Done

A gate set (`packages/core/src/gates.ts`) is a versioned, reusable list
of gates; gate sets compose via `extends` (base gates first, duplicates
by id dropped). Each gate is `required` (failing fails the set) or
advisory (a warning), and one of three kinds:

- **`deterministic`** — `check` is either a scope expression over
  `item.*` (title, state, type, labels, description), `domain.*`,
  `vars.*`, and `results.*`, or a workspace command via the `command:`
  prefix (`check: "command: npm test"` passes on exit 0).
- **`agent`** — `check` is an evaluation goal; the agent must answer
  `{"passed": true|false, "reason": "..."}`.
- **`human`** — `check` is the approval prompt; the gate suspends the
  node on a durable approval wait and consumes the response when it
  arrives.

**Evaluation and remediation are separate by construction.** A failing
gate with a declared `remediation` runs the remediation goal (through
`remediationProfile` or the workflow default profile) at most
`remediation.maxAttempts` times, bounded overall by the node's
`maxRemediationAttempts` (default 0 = disabled) — and after every
attempt the gate **re-evaluates independently**. The remediator never
declares its own fix successful
(`evaluateGateNode`, `packages/orchestrator/src/graph/node-executors.ts`).

A gate node settles with outputs `gateSetName`, `gateSetVersion`,
`passed`, `evaluations` (per-gate verdicts with reasons and attempt
numbers), and `remediationsAttempted` — so transitions can branch on
them and later nodes can cite them.

## Profiles and fallback

An agent profile (`packages/core/src/profiles.ts`,
[adr-0021](adrs/adr-0021.md)) is a versioned execution configuration
**composed from fragments, never inherited**: `compose: [a, b]` applies
fragments in order, then the profile's own fragment. Later fragments
override scalars (primary selection, budget, maxTurns, …); system
prompts concatenate; tool names union; permission rules concatenate. A
profile resolves to a primary executor selection
(`native-<provider>` or an agent CLI id like `claude-code`) plus an
optional **fallback chain**:

```yaml
# kind: agent-profile
name: delivery-default
fragment:
  primary: { executor: claude-code }
  fallback:
    chain: [{ executor: native-anthropic }]
    trigger: outage-only        # or any-failure
  maxTurns: 80
```

`trigger: outage-only` (the default) engages the chain only on provider
outages and rate limits; `any-failure` also engages it on fatal model
errors. Profile resolution happens against the run's pinned snapshot
(`resolveProfileFromSnapshot`,
`packages/orchestrator/src/graph/node-executors.ts`), so a profile edit
never changes a running run. Agent nodes, agent/remediation gates, and
experiment phases all execute through the same profile-driven runner and
fallback logic (`createProfileAgentRunner`).

## Experiments

The experimentation primitive ([adr-0022](adrs/adr-0022.md)):
hypothesis → candidates → optional prototypes → rubric evaluation →
human judgment → bounded iteration → durable learning.

An **experiment definition** (`packages/core/src/experiments.ts`)
declares `candidateCount`, an optional `generationStrategy` hint,
`prototype` (build/test candidates, not just written proposals),
`survivorCount`, `maxIterations`, and a `rubric` reference. A **rubric**
declares weighted criteria (scored 0–10), an `advanceThreshold`, and
**kill criteria** — expressions over candidate evidence
(`candidate.scores.<criterionId>`, `candidate.weightedScore`,
`candidate.evidenceCount`, `outputs.<key>`; see
`packages/experiments/src/runner.ts` for the full scope) that kill a
candidate when true. The rubric version is pinned into the snapshot
before any evaluation happens — scores and the bar they are measured
against cannot drift mid-experiment.

The runner (`packages/experiments/src/runner.ts`) is a resumable state
machine over the persisted `ExperimentRecord`: generate → prototype →
evaluate → select survivors → **awaiting judgment**. The graph binding
(`packages/orchestrator/src/graph/experiment-stepper.ts`) maps
awaiting-judgment onto a durable single-choice wait whose choices encode
the decision:

- `advance:<candidateId>` — advance that survivor
- `iterate` — run another bounded iteration (up to `maxIterations`)
- `need-more-evidence` — gather more evidence on the survivors
- `kill` — conclude the experiment

The judgment prompt is a compact package: hypothesis, rubric summary,
kill criteria, survivors with scores and key evidence, a
recommendation, and risks. The decoded decision is persisted to the
judgment repository (`GET /api/judgments` for observability) and the
runner resumes from the record alone — a judgment can arrive days later
on a different process. A concluded experiment settles the node as
**succeeded** with `outputs.conclusion` = `advanced` / `killed` /
`exhausted` (killed hypotheses are legitimate learnings, not node
failures), `outputs.selected` for an advanced candidate, and
`outputs.learning` — rendered markdown
(`packages/experiments/src/learning.ts`) including rejected approaches,
ready to project into a work item's managed section.

## Lanes and schedules

**Lanes** (`packages/core/src/lanes.ts`,
[adr-0023](adrs/adr-0023.md)) bind a work source to a workflow route
with their own consumption policy. The backlog's native rank order is
canonical — the dispatcher never re-sorts
(`GraphScheduler.dispatchLane`,
`packages/orchestrator/src/scheduling/graph-scheduler.ts`). Three
policies:

- `strict_serial` — one active run; a blocked top item **halts** the
  lane (nothing below it starts).
- `skip_blocked` — one active run; blocked items are skipped, the next
  eligible item runs.
- `ranked_parallel` — fills up to `maxActive` runs in rank order,
  skipping blocked items.

An item with an unresolved `blocked-by` relationship counts as blocked
by default. A lane with a fixed `workflow` routes every item there; a
lane without one routes each item through the routing rules (below).
Lane membership is persisted, so restarts preserve active-run
accounting.

**Schedules** start a workflow on a recurring spec with a synthetic work
item carrying the declared `payload` as variables:

```yaml
# kind: schedule
name: weekly-support-loop
cron: "0 9 * * 1"        # 5-field cron, UTC, minute precision — or "every 30m"
workflow: weekly-support-analysis
payload: { window_days: 7 }
enabled: true
```

Firings are recorded **before** the run starts; the last recorded due
time is the restart-safe baseline, so a schedule fires at most once per
due slot and downtime collapses to a single catch-up firing at the
latest missed slot — never a replay storm, never a double fire. The
daemon evaluates due schedules and due time-waits on its poll interval
(`graphTick` in `packages/cli/src/daemon.ts`).

**Wiring status**: schedules and lanes are both wired. Install and
enable a `schedule` definition and the daemon fires it; install and
enable a `lane` definition and the daemon's periodic tick discovers the
lane's source backlog (in the provider's native rank order) and feeds
it to `GraphScheduler.dispatchLane` (`packages/cli/src/daemon.ts`).
Responding to a `WORKFLOW_SELECTION_REQUIRED` wait routes through the
scheduler's selection path automatically.

## Routing

Work-item routing ([adr-0024](adrs/adr-0024.md),
`packages/orchestrator/src/scheduling/routing.ts`) is deterministic and
never guesses:

- **Zero** matching rules — do nothing beyond an event; a human can
  still start a run explicitly.
- **One** matching workflow — start it, but only when the rule sets
  `autoStart: true`; otherwise just report the match.
- **Many** distinct matching workflows — open (or reuse) a durable
  single-choice wait tagged `WORKFLOW_SELECTION_REQUIRED`; the run
  starts only when a human picks (`overture waits list --reason
  WORKFLOW_SELECTION_REQUIRED`, then `waits respond`). Two rules
  agreeing on the same workflow are not ambiguous.

Rules are scope expressions over the item (`item.labels.bug`,
`item.type == 'story'`, `item.repository == '…'`); rules targeting
non-enabled workflows are ignored. Every human selection is recorded,
and recurring patterns (an attribute value seen on ≥ 3 selections that
all chose the same workflow) become **rule suggestions** — proposals
only. A suggestion becomes a persisted rule solely through an explicit
approval wait (`ROUTING_RULE_PROPOSAL`), and even then with
`autoStart: false`.

Routing runs when a lane has no fixed workflow, or explicitly via
`GraphScheduler.route`; like lane dispatch, the shipped daemon does not
yet call it on its own poll cycle. In the daemon today, v1
trigger/eligibility matching still drives poll-based dispatch
(`POST /api/runs` and `overture run` start v1 runs), and graph runs
start through schedules or custom wiring against
`GraphRunCoordinator.start`.

## Templates

The template catalog (`packages/templates/src/catalog.ts`) ships two
flagship graph workflows with their gate sets, rubrics, experiment
definitions, and default profiles. The daemon installs the catalog into
the definition store on boot; installation is idempotent
(content-addressed — unchanged documents mint no new versions), a
fresh definition is enabled once, and an operator's later `disable` is
never overridden (`packages/cli/src/daemon.ts`). Each template declares
the actions, node kinds, and provider features it requires
(`validateCompatibility`).

**Autonomous Delivery** (`packages/templates/src/delivery.ts`,
workflow `autonomous-delivery`): ranked backlog item → reviewed, gated,
conventional-commit pull request. Node by node:

1. `dor` — gate on `delivery-definition-of-ready`: the item has a
   description (deterministic) and acceptance criteria are stated or
   inferable (agent gate, with one bounded remediation that derives
   them).
2. `plan` — agent produces an implementation plan with structured
   outputs (`approach`, `estimated_complexity`,
   `security_review_required`).
3. `implement` — agent implements code, tests, and docs
   (`retry: maxAttempts: 2`).
4. `test` — command `npm test` (a literal — fork the template for a
   different test command).
5. `review` — independent agent review; structured `approved` +
   `findings`.
6. `remediate` → `re_test` → `re_review` — a bounded remediation loop
   (loop bounds 2/2/2, re-entry bound 1) when review does not approve; a
   re-review that fails again re-enters remediation once more before the
   loop bound fails the run.
7. `dod` — gate on `delivery-definition-of-done`: tests pass
   (`command: npm test`) and a review approved
   (`results.review.outputs.approved == true ||
   results.re_review.outputs.approved == true`).
8. `commit` → `deliver` → `update_item` — conventional commit, pull
   request, and a work-item comment; the deliver transition projects
   `In Review` externally.

It runs in a `git-worktree` workspace under the `delivery-default`
profile (Claude Code primary, native Anthropic fallback on outage), and
suspends durably — with a git-branch checkpoint — whenever an agent
genuinely needs a human.

**Autonomous Discovery** (`packages/templates/src/discovery.ts`,
workflow `autonomous-discovery`): outcome → experiment-validated PRD →
agent-ready stories. Node by node:

1. `investigate` — agent gathers evidence; structured `pain_points`
   (each with provenance) and `evidence_summary`.
2. `hypothesize` — agent forms the single most promising testable
   hypothesis; stored into domain data (`onExit: setData`).
3. `experiment` — experiment node running `discovery-experiment`
   (3 candidates per round, prototyped, 2 survivors, ≤ 3 iterations)
   against `discovery-rubric` (impact 4 / confidence 3 / effort 2 /
   risk 1, advance threshold 6, kill criteria including
   `candidate.evidenceCount == 0`). Killed/exhausted conclusions route
   to a `killed` terminal — a completed run, with the learning captured.
4. `prd` — agent writes the PRD plus `story_candidates`.
5. `capture_prd` — `work.update_section` writes the PRD into the work
   item's managed section.
6. `approval` — human approval before story creation (skipped entirely
   when `vars.stop_after == 'prd'`; remove the node by forking if you
   never want the gate).
7. `create_stories` — fan-out over `story_candidates` into the
   `discovery-create-story` child workflow (one `work.create_item` per
   story, labelled `agent-ready` — ready for Autonomous Delivery to
   pick up). Discovery remains useful without Delivery.

**Forking**: templates are ordinary definitions. Fetch the document
(`GET /api/definitions/workflow/autonomous-delivery`), edit it — the
test command, the gates, the approval — and save it either **under your
own name** (`PUT /api/definitions/workflow/<your-name>`, then `overture
definitions enable workflow <your-name>`) or in place: the boot-time
install (`installTemplates`, `packages/templates/src/catalog.ts`) skips
definitions that already exist, so an in-place edit stays authoritative
across daemon restarts. Restoring the pristine template is an explicit
act (`installTemplates(store, { refresh: true })`), which mints a new
version on top — your edited versions remain in the append-only
history. Prefer a fork when you want the stock template available
alongside your variant.

## Evaluate: side-effect-free dry runs

`POST /api/evaluate` (`{ workflowName, itemExternalId | item,
version?, variables?, hypotheticalOutputs? }`) produces a complete
dry-run report without causing **any** side effect — no run, no claim,
no workspace, no wait, nothing persisted, nothing external mutated
([adr-0026](adrs/adr-0026.md)). The guarantee is structural:
`evaluateWorkflow` (`packages/orchestrator/src/graph/evaluate.ts`)
accepts only narrow read-only ports — a definition reader, a boolean
executor-availability probe, a read-only work-item fetch — so a caller
physically cannot hand it a write path. No clock, no randomness, no
network: the report depends only on the inputs.

The report contains: the workflow's version, lifecycle, and validation
issues; resolved repositories with which mapping rules matched;
discovered instruction files; a context preview under budget; a
per-gate preview (`pass` / `fail` / `indeterminate` — deterministic
expression gates are actually evaluated, agent/human/command gates are
reported indeterminate); the determinable execution path with a stop
reason (`terminal:<node>`, `indeterminate:<node>`, `loop-bound:<t>`,
…); per-node profile resolution with executor availability and
fallback-chain satisfiability; every side effect that *would* occur
(agent sessions, commands, actions, child runs, checkpoints,
projections, comments); and blockers (workflow not enabled, validation
issues, missing profiles/executors, no repository). Supply
`hypotheticalOutputs` per node to walk conditional paths further.

## Release lifecycle

Delivery does not end at the pull request. The release model
(`packages/core/src/release.ts`) represents the post-implementation
stages — `implemented`, `pr-opened`, `merged`, `released`, `deployed`,
`verified` — as a **pure monotonic reducer** over `ReleaseSignal`s:
each stage keeps its first signal as evidence, replays and out-of-order
signals never regress progress. Signals are derived by adapters through
the `ReleaseSignalSource` port (SCM merge status, CI/CD deployments,
issue fields, or `manual`).

Workflows continue past merge by suspending on `external-event` waits
keyed `release:<stage>` — durable, checkpointed, satisfiable days later
by a signal source or a human through the waits API. See
[docs/examples/release-verification.md](examples/release-verification.md)
for a complete post-merge verification workflow, and
[docs/examples/weekly-support-loop.md](examples/weekly-support-loop.md)
for the recurring schedule that closes the loop: weekly support
evidence → clustering → correlation against prior work → dispositions →
agent-ready stories that Autonomous Delivery picks up.

## Command and API quick reference

```sh
overture definitions list [kind]                 # versioned definitions + lifecycle
overture definitions enable|disable <kind> <name>
overture waits list [--run id] [--type kind] [--reason marker]
overture waits respond <id> --value <v> [--by responder]
overture graph-run show <run-id>                 # graph position, domain state, waits
overture runs / run / events                     # unchanged from v1
```

Phase 2 control-plane endpoints (`packages/server/src/http.ts`):
`GET/PUT /api/definitions/...`, `POST /api/definitions/validate`,
`POST /api/definitions/<kind>/<name>/lifecycle`, `GET /api/waits`,
`POST /api/waits/<id>/respond`, `POST /api/evaluate`,
`GET /api/judgments`, `GET /api/graph-runs/<id>`.
