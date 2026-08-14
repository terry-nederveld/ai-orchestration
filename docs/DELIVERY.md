# Delivery Report — Overture v1

Date: 2026-08-14. All work on this delivery is in this repository's history
as Conventional Commits.

## What was built

Overture: a cross-platform autonomous agent orchestrator. A local daemon
polls configured work sources (GitHub Issues, GitHub Projects v2, Jira
Cloud, Jira Data Center, Linear), matches eligible items to declarative
YAML workflows, claims them idempotently, prepares an isolated git-worktree
workspace, and drives agents — the native Pi-style runtime against any
model provider, or Claude Code / Codex / Copilot as delegated agent
runtimes — through plan/implement/test/review/remediate steps, delivering
a Conventional Commit, pushed branch, and pull request, then transitioning
the work item. The CLI and the Tauri desktop app are thin clients of the
daemon's authenticated loopback HTTP/SSE control plane. Every meaningful
occurrence is a typed event, persisted to an append-only log and streamed
live.

## Architecture chosen

Ports-and-adapters around a dependency-free domain core
(`@overture/core`): provider contracts for models, agents, work sources,
source control, workspaces, secrets, workflows, tools, extensions,
notifications, and persistence, with capability-based negotiation instead
of vendor conditionals. Deterministic run state machine with validated
transitions and restart recovery; explicit protocol-tool goal completion;
budgets as first-class domain objects; a DAG workflow engine with
tainted-skip status semantics and assert-gated delivery; SQLite (via
node:sqlite, zero native dependencies) behind repository ports; a single
service layer consumed by CLI, desktop, and any future remote control
plane. Full record: `docs/adrs/adr-0001` … `adr-0016`.

## Supported providers

- **Models (direct API)**: Anthropic, OpenAI, OpenRouter, Ollama, any
  OpenAI-compatible endpoint.
- **Coding agents**: Claude Code (Agent SDK, embedded), OpenAI Codex
  (CLI, JSONL protocol — live-verified against a real ChatGPT-subscription
  session), GitHub Copilot (CLI; adapter complete, live verification
  pending a machine with the CLI installed), plus the native runtime.
- **Work sources**: GitHub Issues (REST), GitHub Projects v2 (GraphQL),
  Jira Cloud (REST v3, `/search/jql`, ADF), Jira Data Center (REST v2,
  offset pagination, PAT), Linear (GraphQL).
- **Source control**: Git (injection-safe CLI adapter) + GitHub pull
  requests via `gh`.
- **Workspaces**: git-worktree (default), git-clone, local-directory,
  temp-directory.

## Authentication mechanisms

API keys resolved from the OS keychain (macOS Keychain, Linux Secret
Service) or an encrypted vault, referenced by name in configuration and
never stored in files or logs. Subscription consumption is supported by
delegating to the vendor's own authenticated tooling (Claude Code CLI
login, `codex login`, `gh`/Copilot session) — Overture never implements a
vendor's consumer login, and adapters build child environments from an
allowlist so a stored subscription login is never overridden by ambient
keys and daemon credentials are never inherited (ADR-0013, ADR-0016).

## How to run and build

`pnpm install && pnpm build`; store a key with
`node packages/cli/dist/main.js secrets set provider/anthropic/api-key`;
configure `~/.config/overture/config.yaml`; run `overture daemon`. Desktop:
`pnpm desktop:build` (macOS .app verified locally; Windows NSIS and Linux
deb/rpm/AppImage configured, buildable on their platforms). Full
walkthrough: `docs/getting-started.md`; per-platform packaging:
`apps/desktop/README.md`.

## How to extend

`docs/extending.md` covers adding each provider type, workflow actions,
tools, extensions (manifest + activate), skills, hooks, and MCP servers —
each against a single interface with a reusable contract suite in
`@overture/testkit` (model, agent, work, scm, workspace, secret,
notification, persistence). Workflow authoring: `docs/workflows.md`
(schema, expression language, execution semantics).

## Test status

Clean-checkout verified: `pnpm install && pnpm build && pnpm test` —
**1,311 tests in 109 files, all passing**; UI: 59 component tests + clean
production build; desktop shell: cargo check/clippy clean, debug .app
built and sidecar supervision verified (spawn/health/attach/SIGTERM) on
macOS arm64. Zero lint errors. End-to-end: a seeded issue travels
discovery → claim → worktree → plan → implement (real file edits, real
test run) → review → assert gate → conventional commit → push to a real
origin → PR invocation → transition, with zero API spend (scripted
model); one live Codex subscription run verified the real agent path.

## Reviews

An independent security review produced 14 findings; all five must-fix
items are remediated (ADR-0016): env-indirect command interpolation
(verified against real bash with hostile payloads), redaction across
event log/SSE/sessions, push-time attribution validation, allowlisted
child environments (native tools, command steps, and all agent
providers), and intent-respecting permission presets — plus symlink-safe
containment, timing-safe control-plane auth, untrusted-content framing,
and stronger redaction. A final independent architecture review confirmed
vendor-neutral boundaries, clean-checkout build, commit hygiene, ADR
validity, and no placeholder implementations; its one blocking finding
(agent-provider environment inheritance) was fixed before delivery, and
its non-blocking items are done (agent contract suite, lint, test
timeout) or documented (delivery-window crash reconciliation, ADR-0007).

## Known limitations

- Jira Cloud, Jira Data Center, and Linear adapters are fully implemented
  and contract-tested against faithful fake backends; live-tenant
  validation requires credentials unavailable in the build environment.
- Copilot adapter awaits live verification on a machine with the CLI.
- Windows secret storage uses the encrypted vault (native Credential
  Manager planned); macOS keychain writes are transiently ps-visible
  (documented, `docs/security.md`).
- Installed desktop apps need the daemon staged as a bundle resource and
  code signing before public distribution (documented,
  `apps/desktop/README.md`); dmg styling requires a GUI session.
- Extensions run unsandboxed in-process by design — stated trust model.

## Non-blocking roadmap

Tracked in `docs/PROGRESS.md` (Deferred / Post-v1): pre-delivery
branch/PR reconciliation, container/remote workspace strategies,
multi-instance work sources, richer control-plane endpoints (single-item
GETs, structured errors, per-run usage attribution), cheapest-suitable
model routing, native Windows keyring, extension tool namespacing.
