# Progress Ledger

Operational state for the Overture build. Kept concise and current; ADRs in
`docs/adrs/` hold the architectural record.

## Product

**Overture** — cross-platform autonomous agent orchestrator. Turns work items
(GitHub Issues, Jira, Linear, …) into autonomous agent executions delivering
commits/PRs. CLI binary: `overture`. Repo-level workflow file:
`.overture/workflow.yaml`. npm scope: `@overture/*` (private packages).

## Current Objective

PHASE 2 in progress: durable general-purpose work orchestration —
graph workflows with separated state layers, version pinning, durable
waits/human input, execution specifications, checkpoint strategies,
repo mapping, instruction/context resolution, DoR/DoD gates, agent
profiles, experimentation/rubrics/judgment, lanes/scheduling,
templates/Evaluate, ambiguous routing, federated desktop, work-centric
run UX, and the workflow designer. v1 delivery report: docs/DELIVERY.md.

## Phase 2 Gap Map (requirement → current v1 state → change)

- Workflow graph + 4 state layers → v1 is an in-memory DAG engine, not
  resumable mid-run; RunState only → new graph model in core (nodes +
  declared transitions + joins + bounded loops), durable tick-based
  GraphEngine; engine lifecycle vs domain state vs external projection
  separated; v1 step-DAG YAML compiles into the graph (no rewrite).
- Versioning/pinning → definitions unversioned → content-addressed
  DefinitionVersion store + immutable per-run ResolvedSnapshot.
- Durable waits/human input → approvals in-memory fail-closed; restart
  recovery marks runs Failed → persisted WaitCondition + HumanInput
  (typed, first-response-wins), checkpointed resume across restarts.
- ExecutionSpecification → none → revisioned immutable spec entity.
- Checkpoints → workspace retention only → git remote branch checkpoint
  strategy for coding; managed work-item section for non-code.
- Repository mapping → adapter-supplied single repo → declarative
  many-to-many rules with precedence + agent-assisted fallback.
- Instruction discovery → none → InstructionProvider chain (CLAUDE.md,
  AGENTS.md, AGENT.md, copilot-instructions) with provenance.
- Context resolution → title/desc/labels + step summaries only →
  composable ContextResolver, 1-up/1-down defaults, opt-in attachments.
- DoR/DoD → none → versioned gate sets, remediation ≠ evaluation.
- Profiles/fallback → routing profiles (executor+model) only →
  versioned composable profiles + deterministic fallback chains.
- Experiments/rubrics/judgment → none → new primitives.
- Fan-out/fan-in → implicit all-join only → all/any/N/named joins.
- Lanes/backlog policies/recurrence → single scheduler loop → lanes,
  rank-preserving consumption policies, cron triggers.
- Templates/Evaluate/routing → first-match auto-run → catalog,
  side-effect-free Evaluate, WORKFLOW_SELECTION_REQUIRED + suggestion
  learning (approval-gated rules).
- Desktop → single runtime, dashboard-first → federated multi-runtime
  connections, work-centric newest-first run UX, designer.

## Phase 2 status

- Committed: phase-2 core contracts (graph model + validation, definition
  versioning/snapshots, durable waits + typed human input, execution
  specs, checkpoints + managed sections, mapping rules, instruction/
  context contracts, gates, profiles, experiments/rubrics/judgment,
  lanes/schedules; 41 tests); durable GraphEngine (tick-based, joins,
  bounded loops, guards, effects, serialization-proven waits; 15 tests);
  GraphRunCoordinator (snapshot pinning, durable suspension with
  checkpoints, first-response-wins, spec revisioning on resume, timer
  scans, child runs, human gates; 16 tests). ADRs 0017–0020.
- In flight (agents): phase-2 persistence repositories (SQLite +
  in-memory; in-memory already validated by coordinator tests),
  resolution package (instructions/context), checkpoints package
  (git-branch + work-item-section strategies, WorkProvider body access),
  v1→graph compiler, experiments engine, agent-UX research.
- Next: flagship Delivery + Discovery templates, lanes/scheduling/
  recurrence, routing (selection-required + suggestions), server
  endpoints for waits/definitions/runs-graph, desktop federation +
  work-centric UX + designer, acceptance scenarios A/B, reviews.

## Completed Milestones

- 2026-08-14: Repository inspected (clean slate). Environment: macOS 26.6,
  Node 26.7 + pnpm 10, Rust 1.89, local CLIs available: `claude`, `codex`,
  `gh`, `ollama` (no `copilot` CLI installed).
- 2026-08-14: Four research agents dispatched (Symphony/Pi, agent SDKs & auth,
  work provider APIs, desktop frameworks).
- 2026-08-14: Workspace scaffolded (pnpm monorepo, TypeScript strict, vitest,
  Biome).
- 2026-08-14: `@overture/core` committed — full domain model, ports, state
  machines, budget tracker, event bus (19 tests).
- 2026-08-14: `@overture/runtime` + `@overture/tools` committed — native agent
  loop (explicit completion protocol, budgets, compaction, sub-agents,
  resume; 17 tests) and workspace-contained coding tools (15 tests).
- 2026-08-14: `@overture/policy` committed — rule-based permission engine +
  approval gateways (9 tests).
- 2026-08-14: `@overture/config` committed — layered config (8 tests).
- 2026-08-14: ADRs 0001–0006 committed.

## Architecture Decisions (see docs/adrs/)

- 0001 TypeScript/Node core; 0002 pnpm monorepo; 0003 ports-and-adapters +
  capabilities; 0004 state machines + explicit completion; 0005 budgets;
  0006 event bus. Pending after research: desktop framework, process model,
  persistence (node:sqlite), workflow format, workspace isolation, auth
  strategies, MCP.

## Active Work

- In flight: Tauri shell + packaging (apps/desktop/shell), final
  independent architecture review.
- Completed since: agent providers (live-verified Codex subscription run),
  CLI + daemon (composition root, live smoke test), desktop web UI, MCP
  integration, docs (user+developer+security), independent security
  review with all five must-fix findings remediated (ADR-0016):
  command interpolation via env indirection, redaction across event
  log/SSE/sessions, push-time attribution validation, workspace env
  allowlist, explicit permission presets. Plus symlink containment,
  timing-safe auth, untrusted-content framing, full-UUID ids.
- Committed since last update: workflow engine (tainted-skip rule, 93
  tests), orchestrator kernel (multi-source work resolution,
  workflow.assert action), extensions (36 tests), all four work providers
  (GitHub 44, Jira Cloud+DC 91, Linear 75 tests), server control plane
  (10 tests), secrets (11 tests), config (8 tests), e2e vertical slice
  (real git origin → worktree → scripted-model native runtime → real
  tools → conventional commit → push → gh PR → transition; passing).
- CLI + daemon assembly written; compiles once agent-* packages land.

## Integration decisions made while wiring

- when-gates choose whether a step runs; assert-gates decide success.
  Delivery is gated on `workflow.assert` (`when: 'true'`, condition over
  step results) because when-false skips are benign by design and could
  otherwise mask failures. Built-in workflow uses this pattern.
- Orchestrator resolves work providers per item (multi-source);
  multiple instances of the same adapter type deferred post-v1.
- Jira claim marker is label-presence (not per-claimant idempotent);
  authoritative claiming is the kernel ClaimStore. GitHub/Linear use
  claimant comment markers and pass the shared contract suite.
- Per-package tests run as `vitest run --root ../.. --project <name>`.
- ScriptedModelProvider snapshots request messages (runtime mutates arrays).

## Planned Package Layout

```
packages/
  core/              domain model, ports/contracts, events, capabilities (pure)
  testkit/           deterministic fakes + provider contract test suites
  persistence/       SQLite persistence adapters
  runtime/           Pi-style agent loop + tool runtime
  workflow/          workflow schema + engine
  orchestrator/      kernel, scheduler, policy, budget
  workspaces/        worktree/clone/dir/temp workspace providers
  scm-git/           git + GitHub source-control provider
  secrets/           OS keychain + encrypted fallback
  extensions/        extension loader, MCP, skills, hooks
  providers/model-anthropic, model-openai (incl. OpenAI-compatible),
            agent-claude-code, agent-codex, agent-copilot,
            work-github, work-jira-cloud, work-jira-datacenter, work-linear
  server/            local control-plane daemon
  cli/               overture CLI
apps/
  desktop/           desktop shell + UI
```

## Known Limitations / Risks

- Copilot CLI not installed on the build machine: adapter is implemented
  and unit-tested with clean not-installed detection; live verification
  pending a machine with the CLI (subscription paths live-verified with
  Codex; Claude Code detection verified live).
- Jira Cloud / Data Center / Linear adapters are contract- and
  fake-backend-tested; live validation requires tenant credentials not
  available in this environment (documented external limitation).
- Distribution packaging gaps documented in apps/desktop/README.md:
  daemon resource staging for installed apps, code signing/notarization,
  Windows/Linux bundles buildable only on their own platforms.

## Test Status

- Full workspace suite green: ~1,300 tests across 100+ files (unit,
  contract, integration, e2e vertical slice over real git). UI: 59
  component tests. Desktop shell: cargo check/clippy clean; debug .app
  built and supervision-verified on macOS arm64. Live verification:
  daemon boot + CLI smoke, one real Codex subscription agent run.

## Deferred / Post-v1

- Windows native Credential Manager adapter (encrypted-file fallback in
  v1; @napi-rs/keyring is the designated upgrade path, ADR-0015).
- Container/remote workspace strategies behind the WorkspaceProvider port.
- Multiple instances of one work-provider type (config supports it;
  per-instance claim resolution needs instance ids).
- Control-plane API: single-item GET endpoints, structured error
  payloads, state/label enumeration, per-run usage attribution (UI
  works around all four client-side).
- Tool-name collision warnings in the registry; extension tool
  namespacing.
- macOS keychain argv exposure (ps-visible transiently on write) —
  documented in docs/security.md.
- Cheapest-suitable-model automatic routing (capability data exists).
- Delivery-window crash reconciliation: a crash between push/PR and the
  work-item transition wastes one redundant re-run (fails visibly on the
  non-fast-forward push; no corruption). Planned: pre-delivery
  existing-branch/PR check (ADR-0007 consequences).
- Dependabot alert GHSA-wrw7-89jp-8q8g (glib VariantStrIter unsoundness,
  transitive via Tauri's GTK bindings) dismissed as tolerable risk: no
  patched version reachable from Tauri 2.x's tree; revisit when Tauri
  adopts the gtk-rs 0.20 stack.

## Important Constraints

- Conventional Commits everywhere; NO attribution/credit footers, NO watermarks.
- Ports-and-adapters; vendor names never in domain logic.
- ADRs: docs/adrs/adr-####.md with YAML frontmatter, monotonic numbering.
- Tests must not spend real API credits by default.
