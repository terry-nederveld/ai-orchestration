# Progress Ledger

Operational state for the Overture build. Kept concise and current; ADRs in
`docs/adrs/` hold the architectural record.

## Product

**Overture** — cross-platform autonomous agent orchestrator. Turns work items
(GitHub Issues, Jira, Linear, …) into autonomous agent executions delivering
commits/PRs. CLI binary: `overture`. Repo-level workflow file:
`.overture/workflow.yaml`. npm scope: `@overture/*` (private packages).

## Current Objective

Research complete → write initial ADRs → implement core (domain, events,
persistence, fakes, runtime, workflow engine, orchestrator) → vertical slice →
providers → control plane/CLI → desktop UI → packaging → hardening → docs.

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

## Known Failures / Risks

- Copilot CLI not installed locally; subscription-agent target will lead with
  Claude Code (installed + authenticated locally) — verify during provider work.
- Jira Cloud / Data Center / Linear live validation depends on credential
  availability; contract tests + documented limitation as fallback.

## Test Status

- No code yet.

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

## Important Constraints

- Conventional Commits everywhere; NO attribution/credit footers, NO watermarks.
- Ports-and-adapters; vendor names never in domain logic.
- ADRs: docs/adrs/adr-####.md with YAML frontmatter, monotonic numbering.
- Tests must not spend real API credits by default.
