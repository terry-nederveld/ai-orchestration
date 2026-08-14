# Authoring Workflows

A workflow is a YAML document describing a DAG of steps — agent goals, shell
commands, registered actions, and human approvals — with dependencies,
conditions, retries, and timeouts. This page is the full format reference,
the expression language, the exact execution semantics, and an annotated
walkthrough of the built-in `software-development` workflow.

The implementation is `packages/workflow/src`: `schema.ts` (Zod validation
of the raw YAML shape), `parser.ts` (raw shape → the stable
`WorkflowDefinition` contract in `@overture/core`), `expressions.ts` (the
`when`/interpolation language), `engine.ts` (execution), and
`builtin-workflows.ts`.

## Where workflow files live

Three sources, composed together (`packages/cli/src/daemon.ts`):

1. **Built-in** — `software-development`, defined in-process
   (`packages/workflow/src/builtin-workflows.ts`), always available.
2. **`orchestrator.workflowsDir`**, if configured — every `*.yaml`/`*.yml`
   file in that directory.
3. **`<project>/.overture/`** — every `*.yaml`/`*.yml` file there, when the
   daemon is started with a project directory.

Definitions are keyed by their `name:` field. When two sources define a
workflow with the same name, the later source in the list above wins —
built-in loses to `workflowsDir`, which loses to the project directory — so
a project can deliberately replace the built-in `software-development`
workflow by reusing its name, or add independent workflows under different
names. Workflow files are read fresh on every scheduler poll, so editing one
takes effect without restarting the daemon.

On each poll, for every discovered work item, the scheduler picks the
**first** workflow (in the composed list's order) whose `trigger` and
`eligibility` both accept the item (`packages/orchestrator/src/eligibility.ts`).
If you add workflows alongside the built-in one, give them distinct names
and make sure their triggers don't overlap in ways you don't intend.

## Top-level fields

```yaml
name: <string>                  # required, unique
description: <string>           # optional
trigger:
  states: [<string>]            # optional
  labels: [<string>]            # optional
eligibility:
  labels:
    include: [<string>]
    exclude: [<string>]
  types: [<string>]
  assignee: unassigned | <string>
workspace:
  strategy: <string>            # e.g. git-worktree, git-clone, local-directory, temp-directory, none
  retention: always | on-failure | never
variables:
  <name>: <string>
budget: <string>                # references config `budgets.<name>`; not yet enforced (see configuration.md)
steps: [ ... ]                  # required, at least one
transitions:
  success: <string>
  failure: <string>
  blocked: <string>
```

**`trigger`** is checked first: if `states` is non-empty, the item's
`state` must be in the list (exact string match); if `labels` is non-empty,
at least one must be present on the item. Both are optional — an absent
`trigger` accepts every state and label.

**`eligibility`** is checked next, and every configured condition must
hold: every `labels.include` entry must be present; no `labels.exclude`
entry may be present; if `types` is set, the item's `type` must be a member
(GitHub Issues never populate `type`, so a `types` gate can never be
satisfied by a GitHub-sourced item — see [getting-started.md](getting-started.md));
`assignee: unassigned` requires zero assignees, anything else is currently
accepted but not matched against a specific assignee.

**`workspace.strategy`** selects a `WorkspaceProvider` by name (see
[architecture.md](architecture.md)); omit it and it defaults to
`git-worktree` in code (not from `config.workspaces.defaultStrategy`, which
is not yet wired — see [configuration.md](configuration.md)). `none`
disables workspace creation entirely (steps get no `${{ vars.workspace_path }}`
and command steps, which require a workspace, will fail). `retention`
similarly defaults to `on-failure` in code.

**`variables`** seeds the expression context's `vars.*` namespace. The
orchestrator also injects, per run, `vars.work_id`, `vars.work_title`,
`vars.work_url`, `vars.work_state`, `vars.work_provider`,
`vars.workspace_path`, and `vars.branch` — these take precedence over any
`variables:` entry of the same name.

**`transitions`** are applied automatically once the workflow finishes —
not via a step — by looking up the run's outcome (`success`, `failure`, or
`blocked`) in this map and calling the work provider's `transition()` with
the corresponding value, plus a comment summarizing every step's outputs.
`success` fires when every terminal step succeeded (see below); `failure`
fires when the workflow failed; `blocked` fires specifically when the
**run itself was cancelled** (e.g. via `overture runs cancel`) — it does
not fire for an ordinary agent-level `GOAL_BLOCKED`/`HUMAN_INPUT_REQUIRED`
outcome, which instead fails the *step* (and, unless forgiven, the
workflow) in the normal way.

## Steps

Every step has an `id` (unique) plus common fields, and exactly one
kind-discriminating field (`agent`, `command`, `action`, or `approval`):

```yaml
- id: <string>                  # required, unique
  depends_on: [<string>]        # optional, must reference other step ids
  when: <expression>            # optional
  timeout: 30s | 10m | 2h | 500ms
  retry:
    max_attempts: <int>         # >= 1
    backoff: 5s
  continue_on_failure: <bool>
```

Durations are a number immediately followed by `ms`, `s`, `m`, or `h`
(`packages/workflow/src/duration.ts`).

### `agent` steps

```yaml
- id: implement
  agent: coder                  # role label, and routing fallback
  goal: >-
    Implement the plan produced by the analyze step...
  route: coder                  # routing profile name; falls back to `agent`, then to routing.defaultProfile
  tool_names: [read_file, write_file, edit_file, run_command]   # optional; omit to allow every registered tool
  max_turns: 40                 # optional; defaults to 50 in code if omitted
```

`goal` (interpolated) becomes the agent's task; the orchestrator also
appends the work item's title/URL/state/labels/description and the
`summary` output of every already-settled step, so later steps see earlier
steps' reasoning without you wiring it explicitly. `route` selects a
`routing.profiles` entry from config (see [configuration.md](configuration.md));
if omitted, the step's `agent` role name is tried as a profile name before
falling back to `routing.defaultProfile`. The step's declared outputs are
whatever the agent reports as structured output in its own final summary —
the built-in workflow's `analyze` step, for example, asks the planner to
report `title` and `plan`, which downstream steps read as
`steps.analyze.outputs.title`.

### `command` steps

```yaml
- id: test
  command: ${{ vars.test_command }}
  cwd: subdir                   # optional; resolved relative to the workspace root
  env:
    CI: "true"
  timeout: 10m
  retry:
    max_attempts: 2
    backoff: 5s
```

Runs via `/bin/bash -c` (`cmd.exe` on Windows), inside the run's workspace.
Requires a workspace (a `command` step in a `workspace.strategy: none`
workflow always fails). Output is captured (stdout+stderr, capped at 60,000
characters) as `steps.<id>.outputs.output`; exit code as
`steps.<id>.outputs.exitCode`. A non-zero exit is a step failure.

### `action` steps

```yaml
- id: deliver
  action: source_control.pull_request
  with:
    title: ${{ steps.analyze.outputs.title }}
    body: ${{ steps.analyze.outputs.plan }}
```

`action` names a registered `WorkflowAction` (built-in ones below, or one
contributed by an extension — see [extending.md](extending.md)). `with` is
an arbitrary key/value bag passed to the action; string values are
interpolated, other JSON value types pass through unchanged.

**Built-in actions** (`packages/orchestrator/src/actions.ts`):

| id | `with` | Behavior |
|---|---|---|
| `workflow.assert` | `condition`, `message?` | Succeeds only if `condition` is the string/boolean `true`; otherwise fails with `message` (or a default). See the assert-gate pattern below. |
| `source_control.commit` | `message` | Stages everything and commits, unless the tree is already clean. |
| `source_control.push` | — | Pushes the run's branch. |
| `source_control.pull_request` | `title?`, `body?`, `target_branch?`, `draft?` | Pushes the branch, then opens a pull request (title/body default to the work item's own title/URL when omitted). Publishes `delivery.pull_request.created`. |
| `work.comment` | `body` | Comments on the work item. |
| `work.transition` | `state` | Transitions the work item to `state` immediately (independent of the workflow-level `transitions:` block, which fires once at the very end). |

### `approval` steps

```yaml
- id: human_gate
  approval: Confirm this change is safe to deliver.
```

The `approval:` value **is** the description text (not a separate field).
Publishes `approval.requested`, blocks on the configured `ApprovalGateway`,
publishes `approval.resolved`, and succeeds/fails based on the human
decision (`overture approvals approve|deny <id>`, or the desktop UI).

## Expression language

`when` conditions and `${{ ... }}` interpolation share one tiny, safe
expression language — a hand-rolled tokenizer and recursive-descent parser,
no `eval`/`Function` (`packages/workflow/src/expressions.ts`):

```
or         := and ( '||' and )*
and        := equality ( '&&' equality )*
equality   := unary ( ('==' | '!=') unary )*
unary      := '!' unary | primary
primary    := STRING | NUMBER | 'true' | 'false' | reference | '(' or ')'
reference  := 'steps.' IDENT '.' ('succeeded'|'failed'|'skipped'|'status')
            | 'steps.' IDENT '.outputs.' IDENT
            | 'vars.' IDENT
```

String literals use single quotes (`'like this'`). Examples:

```yaml
when: steps.review.failed
when: steps.remediate.succeeded
when: steps.review.succeeded || steps.re_review.succeeded
when: vars.environment == 'production' && !steps.smoke_test.failed
```

**Interpolation** (`${{ expr }}`) is resolved against the same context
(`vars.*`, settled `steps.*`) in a step's own template-ish string fields —
`agent.goal`, `command`/`cwd`/env values, `action.with` string values, and
`approval`'s description — immediately before that step (or retry attempt)
runs, using the latest variables and whatever steps have settled by then.
`when` is exempt: it is evaluated as an expression directly, never
string-interpolated first.

## Execution semantics

The engine (`packages/workflow/src/engine.ts`) never performs work itself —
every step kind is delegated to an executor. Its scheduling and status
rules are exact and worth understanding precisely, because they determine
whether an unattended workflow reports success or failure correctly.

**Scheduling.** A step becomes eligible to run once every dependency has
*settled* (reached `succeeded`, `failed`, or `skipped`). All currently
eligible steps run concurrently (unbounded by default).

**Eligibility, once dependencies have settled:**
- If the step declares `when`, that expression is the *entire* rule: true
  runs it, false skips it. This is how a remediation step runs specifically
  *because* a dependency failed (`when: steps.review.failed`).
- Otherwise, the step runs only if every dependency **succeeded**, or
  **failed with that dependency's own `continue_on_failure: true`** (which
  lets dependents proceed as if it had succeeded). Any other outcome skips
  this step, and that skip propagates onward the same way.

**The tainted-skip rule, and why it matters for unattended delivery:**
- A step that fails *without* `continue_on_failure` is **tainted**.
- A no-`when` skip caused by a tainted or unforgiven-failed dependency is
  itself tainted, and taint keeps propagating through further no-`when`
  skips.
- A skip caused purely by `when` evaluating false is **always benign** —
  full stop, regardless of what the expression checked. `when` is how an
  author declares "this step is optional here," so its own skip can never
  fail the workflow.

**Overall status**: a "terminal" step is one nothing depends on. The
workflow succeeds iff every terminal step ended `succeeded`, or `skipped`
*without* being tainted, or `failed` with its own `continue_on_failure`.
Any terminal step that's `failed` (without `continue_on_failure`) or a
tainted `skipped` fails the whole workflow.

**The practical consequence**: if your delivery step's eligibility is
gated entirely behind `when` (e.g.
`when: steps.review.succeeded || steps.remediate.succeeded`), that gate's
own skip is always benign — so if *neither* branch actually succeeded, a
`when`-gated delivery step simply never runs, and nothing fails the
workflow. **A genuine "nothing worked" outcome must be decided by a step
that runs unconditionally and can actually fail.** This is exactly what the
`workflow.assert` action is for — the pattern the built-in workflow uses is:
**when-gates choose whether to run; assert-gates decide success.**

The built-in workflow's `ensure_validated` step is the canonical example —
see the annotated walkthrough below.

**Retries**: `retry.max_attempts` reruns a failed step (re-interpolating
its fields fresh each attempt), sleeping `retry.backoff` between attempts.
**Timeouts**: `timeout` races the step against a deadline; a step that
doesn't respect cancellation is superseded at the engine level regardless
(though only a cooperative executor actually stops working — the command
executor does send `SIGKILL` on abort).

**Cancellation**: aborting the run signals every in-flight step
cooperatively, launches nothing new, waits for in-flight steps to settle,
and marks every step that never started `skipped` (reason: workflow
cancelled). The workflow's own result status is `cancelled`, which the
orchestrator maps to run state `CANCELLED` and — separately — to the
`transitions.blocked` work-item transition, if configured.

## The built-in `software-development` workflow, annotated

The full source is `packages/workflow/src/builtin-workflows.ts`. Its
trigger requires state `Ready for Agent`; its eligibility requires the
label `agent-ready`, forbids `blocked`, and requires type `bug`, `feature`,
or `chore` (a gate no shipped work provider currently satisfies out of the
box for GitHub — see [getting-started.md](getting-started.md) — Jira sets a
`type` but with vendor-cased names like `"Bug"`, and Linear sets none).

```yaml
steps:
  - id: analyze        # agent: produces a plan + PR title as outputs
  - id: implement       # agent, depends_on: [analyze]; commits its own work
  - id: test             # command, depends_on: [implement]; npm test by default
  - id: review           # agent, depends_on: [implement, test]
  - id: remediate        # agent, when: steps.review.failed — optional fix-up pass
  - id: re_review        # agent, when: steps.remediate.succeeded
  - id: ensure_validated # action: workflow.assert, when: 'true' (always runs)
  - id: deliver           # action: source_control.pull_request, depends_on: [ensure_validated]
```

`remediate` and `re_review` are legitimately `when`-gated: they're optional
work, correctly skipped-and-benign when review passes the first time.
`ensure_validated` is the load-bearing step: `when: 'true'` means it's
*always* eligible once `review` and `re_review` have settled
(`depends_on: [review, re_review]` still drives that ordering), and its
`condition` is
`${{ steps.review.succeeded || steps.re_review.succeeded }}`. If neither
review passed, the assert throws — a genuine step failure, tainting
`ensure_validated`. `deliver` depends on `ensure_validated` with a plain
`depends_on` (**no `when`**), so that taint propagates and correctly fails
the workflow instead of silently skipping delivery. `transitions` map
success to `Done`, failure to `Agent Failed`, and a cancelled run to
`Needs Attention`.

Note there is no separate `source_control.commit` step: the `implement`
step's own goal instructs the coding agent to commit its work (via its
`run_command` tool) using Conventional Commits, and `deliver`
(`source_control.pull_request`) pushes the branch itself before opening the
PR — no explicit `source_control.push` step is needed either.

The workflow runs entirely unattended by design — no `approval` step is
built in. Add one to your own copy if you want a human gate before
delivery; see the `approval` step reference above.
