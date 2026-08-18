# Overture Phase 2 — Delivery Report

Durable, general-purpose work orchestration on top of the v1 agent
orchestrator. This report distinguishes what is **implemented**,
**validated**, **partial**, and **deferred**, and records the two
independent reviews and their remediation.

## Headline

Phase 2 turns Overture from a v1 step-DAG runner into a durable graph
workflow engine: resumable across daemon restarts, suspendable on typed
human input for days, versioned and pinned per run, with experiments,
gates, profiles, lanes, scheduling, routing, a template catalog, a
side-effect-free Evaluate, a federated desktop, and a visual workflow
designer. Both flagship templates — Autonomous Delivery and Autonomous
Discovery — run end to end, including survival of coordinator
destruction mid-run.

- **Scope:** 49 commits (`e7e1f95..HEAD`), Conventional Commits, no
  attribution/watermarks anywhere (audited across full history and tree).
- **Tests:** 1,779 package tests (129 files) + 89 desktop UI tests, all
  green from a clean clone; `tsc --build` and `biome check` clean.
- **Reviews:** independent architecture review (4 must-fix, all fixed)
  and independent security review (3 high, all fixed) — both by agents
  that did not build the system, both remediated with regression tests.

## Acceptance scenarios (validated)

Both are automated end-to-end through `GraphRunCoordinator` with scripted
executors — **no paid model calls** (`packages/templates/src/scenarios.test.ts`).

- **Scenario A — Autonomous Delivery** (§34): a ranked backlog item goes
  through the Definition-of-Ready gate, plan, implement, test, review
  with a bounded remediation loop, Definition-of-Done gate, conventional
  commit, and pull request. The implementing agent hits genuine ambiguity
  and the run **suspends durably** on a checkpointed human-input wait; a
  **brand-new coordinator instance** (the original discarded — "kill the
  daemon") resumes from persisted state alone and delivers. Asserted: the
  commit message carries no attribution, the PR opens from the run
  branch, the work item is commented, and a DoD that cannot pass fails
  the run without committing or opening a PR.

- **Scenario B — Autonomous Discovery** (§35): outcome → evidence
  investigation → hypothesis → rubric-judged experiment (candidates,
  prototype, evaluation, human judgment) → PRD captured into the work
  item's managed section → configurable approval → fan-out story
  creation linked child-of the outcome item. Human judgment arrives
  **across a coordinator restart**; the judgment is persisted for
  observability; a `kill` judgment concludes the workflow as recorded
  learning, not failure. Durable work-item learning is proven by the
  managed-section PRD surviving and the stories linking back.

## Implemented and validated

Every item below has automated tests; "validated" additionally means
exercised end-to-end or live-verified.

- **Durable graph engine** (ADR-0017) — tick-based resumable reducer,
  four separated state layers (graph position / engine lifecycle / domain
  state / external projection), joins (implicit/any/all/min), bounded
  loops, guards, lifecycle effects; JSON-serialization-proven durability.
- **Versioning and pinning** (ADR-0018) — content-addressed definition
  versions, DRAFT/ENABLED/DISABLED lifecycle, immutable per-run
  snapshots; a running parent — and now its children — never observe a
  mid-flight edit.
- **Durable waits and typed human input** (ADR-0019) — typed requests
  (approval/text/single-choice/multiple-choice/boolean/free-form/secret/
  file-reference), app/work_item/both surfaces, first-valid-response-wins
  with supplemental capture, satisfiable via CLI or API.
- **Execution specifications** — revisioned, reconciled on resume
  (revision N+1 only on material change), assembled from mapping rules
  and instruction discovery with provenance.
- **Checkpoints** (ADR-0020) — git-branch WIP commits for coding runs,
  work-item managed section for non-code (refuses damaged/duplicated
  delimiters); restore selects by the checkpoint's own strategy id.
- **Repository mapping** — declarative many-to-many rules with priority
  and merge/replace, from config.
- **Instruction & context resolution** — convention providers (CLAUDE.md,
  AGENTS.md, …) and relationship context resolver.
- **Gates** — versioned DoR/DoD gate sets, deterministic/agent/human
  gates, `command:` checks, bounded remediation separate from evaluation.
- **Profiles & fallback** (ADR-0021) — composable fragments, snapshot-
  pinned resolution, outage-only vs any-failure fallback chains.
- **Experiments** (ADR-0022) — definition + pinned rubric + candidates +
  kill criteria + human judgment (advance/iterate/need-more-evidence/
  kill) + bounded iteration + learning capture; bound to the graph as a
  durable single-choice wait.
- **Fan-out/fan-in** — all/any/min joins; width bounded by
  maxConcurrency and a hard ceiling.
- **Lanes & scheduling** (ADR-0023) — strict_serial/skip_blocked/
  ranked_parallel with rank preservation; cron/interval schedules with
  no double-fire; both driven by the daemon tick.
- **Routing** (ADR-0024) — zero/one/many semantics,
  WORKFLOW_SELECTION_REQUIRED durable wait, approval-gated rule
  suggestions; selection and rule-approval routed from the daemon.
- **Template catalog** (§25) — Autonomous Delivery and Discovery,
  idempotent install-on-boot that never supersedes operator edits,
  capability validation.
- **Side-effect-free Evaluate** (ADR-0026) — full dry-run report with a
  zero-write guarantee proven by recording proxies over every persistence
  surface.
- **Release lifecycle** (§24) — monotonic stage model with a signal-
  source port; worked examples for the weekly support loop and post-merge
  verification.
- **Control plane** — authenticated endpoints for waits, definitions +
  lifecycle, graph-run views, validate, evaluate, judgments; CLI
  commands; all redacted.
- **Federated desktop** (ADR-0025) — N named local/remote runtimes,
  client-side aggregation, stale degradation; work-centric newest-first
  activity surface with needs-you badges; typed wait forms; graph-run
  detail; judgment observability.
- **Workflow designer** (ADR-0026) — SVG graph canvas and YAML editor as
  two projections of one canonical document, validation-gated save, and
  an Evaluate panel.
- **v1 → graph compiler** — compiles v1 step DAGs into the graph model
  preserving semantics (benign-skip channels, taint-as-stall).
- **Daemon assembly** — the composition root wires the graph coordinator,
  scheduler, checkpoint selector, spec builder, experiments, secret sink,
  and template install; **live-verified**: boots, serves enabled
  templates, enforces auth (401), keeps the bearer token out of logs,
  shuts down clean.

## Independent architecture review — remediated

Four must-fix findings, all fixed with regression tests:

- **Satisfaction delivery / re-yielded waits** — a node answering a
  satisfaction stayed runnable and its next wait was dropped in a loop
  (broke the Discovery `iterate` path). Satisfactions are now consumed
  exactly once; a re-yielded wait is recorded.
- **Retry vs join accounting** — local retries skewed implicit-join
  counters, stalling later loop re-entry into a retried node. Retries now
  use a separate persisted counter.
- **Crash windows** — waits now persist before the waiting state, and
  recovery reconciles waiting runs against durable wait rows (recreating
  lost conditions, replaying satisfied-but-unconsumed ones). No crash
  window leaves a run permanently stuck.
- **Claim leaks** — durable cancel and the failure path release claims;
  recovery sweeps orphaned claims.

Should-fix items also addressed: per-run serialization, checkpoint-
restore selection + refuse-to-suspend-uncheckpointed, tick-overlap guard,
child snapshot inheritance, non-blocking recovery, graph-run cancel
reachability, and rule-approval routing.

## Independent security review — remediated

Overall MODERATE; the v1 hardening chain re-verified intact (env
allowlist, timing-safe tokens, arg-array git, attribution enforcement at
both choke points incl. checkpoints and templates, prototype-pollution
guards, generic redaction, uniformly-escaped UI). Three high findings,
all fixed with tests:

- **Unbounded fan-out** — bounded by maxConcurrency + hard ceiling;
  over-wide lists fail without starting any child.
- **Secret human input persisted raw** — stored out-of-band under
  secretName, only the name flows on; masked UI input; fails closed.
- **Bearer token in logs** — method+path-only logging; token tracked by
  the redactor.

Medium fixes: managed-section duplicate-delimiter injection, mapping
regex ReDoS bound, corrected false interpolation claim, Tauri CSP.

## Partial / deferred (documented, not silent)

- **Fan-out staged concurrency** — `maxConcurrency` bounds width today;
  true staged execution (start N, refill as they finish) is deferred.
- **Phase-2 persistence redaction (M6)** — a blanket redact-at-save was
  intentionally NOT added because its JSON round-trip corrupts Date
  fields; the primary secret-persistence sink is closed by the secret-
  input fix. A Date-safe redaction helper is the planned path.
- **Checkpoint staged-content secret scan (M2)** — WIP commits stage the
  whole dirty tree; documented as a trust boundary with a planned scan.
- **Desktop token storage (M3)** — localStorage with a restrictive CSP
  backstop; OS secure storage is the planned hardening.
- **v1 scheduler / graph lanes dual-dispatch (S8)** — shared claims
  prevent double-execution; which engine processes an unclaimed item is a
  poll-timing race until the two are scoped apart in config.
- **Live provider validation** — Jira/Linear/Copilot paths remain
  contract- and fake-tested; live validation needs tenant credentials and
  a Copilot CLI (documented in v1 delivery).
- **v1 compiler tainted-skip corner case** — one documented semantic
  divergence, unexercised by built-in workflows.

## Final validation checklist (§40)

- [x] Clean clone builds (`tsc --build`) and lints (`biome check`) with
      zero errors.
- [x] Full suite green from clean checkout: 1,779 package + 89 UI tests.
- [x] Both acceptance scenarios pass, including coordinator destruction
      between suspension and resume.
- [x] Evaluate proven side-effect-free (recording-proxy zero-write test).
- [x] Commit history and source tree free of attribution/watermarks
      (audited).
- [x] Independent architecture review — all must-fix remediated.
- [x] Independent security review — all high remediated; residuals
      documented.
- [x] Live daemon boot verified: templates enabled, auth enforced, token
      not logged, clean shutdown.
- [x] Docs: durable-workflows reference + updated architecture,
      configuration, getting-started, workflows, security, and ADRs
      0017–0026.
