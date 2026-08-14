# Architecture Overview

Overture is a ports-and-adapters system ([adr-0003](adrs/adr-0003.md)): a
small, vendor-free core defines every seam, and every integration —
model, coding agent, tracker, source control, workspace strategy — is a
replaceable adapter behind it. This page is the one-page map; the ADRs
hold the reasoning, and the other docs in this directory hold the detail.

## Layers

```
  work sources (GitHub / Jira Cloud / Jira DC / Linear)
        │  discover()
        ▼
  Scheduler  ──poll, evaluate trigger+eligibility, claim──▶  RunCoordinator
        │                                                          │
        │                                            prepares workspace, branch
        ▼                                                          ▼
                      Workflow Engine (DAG: agent / command / action / approval steps)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
           Agent executors          Command runner            Workflow actions
    (native runtime | Claude Code |  (shell, in the       (assert, commit, push,
     Codex | Copilot — same          workspace)             pull_request, comment,
     AgentProvider contract)                                 transition)
                    │
        tools, gated by PolicyEngine
     (filesystem, process, git, MCP, …)
                    │
                    ▼
        SCM + Workspace providers (git worktree/clone, GitHub PRs)
                    │
                    ▼
              Delivery (pull request, work-item transition)
```

Everything in this diagram observes and is observed only through the
**event bus** ([adr-0006](adrs/adr-0006.md)) and the **persistence layer**
([adr-0010](adrs/adr-0010.md)) — the runtime never imports UI, CLI, or
notification code directly.

## Package map

**Core**

- `packages/core` — domain model, every port interface (`ModelProvider`,
  `AgentProvider`, `WorkProvider`, `SourceControlProvider`,
  `WorkspaceProvider`, `SecretProvider`, `PersistenceProvider`,
  `ToolProvider`, `ExtensionProvider`, `WorkflowProvider`, `EventBus`),
  capability negotiation, budgets, permissions, the run state machine, and
  the event union. Zero dependencies by design.
- `packages/testkit` — deterministic fakes plus reusable contract-test
  suites (`describe*ProviderContract`) that every real and fake adapter for
  a given port must pass.

**Execution**

- `packages/runtime` — the native Pi-style agent loop: streams a
  `ModelProvider`, drives tool calls through policy, enforces budgets,
  compacts context, spawns sub-agents, and terminates only via the
  explicit protocol tools (`complete_goal`, `request_human_input`,
  `run_subagent`) — never on text output alone
  ([adr-0004](adrs/adr-0004.md)).
- `packages/tools` — the built-in, workspace-contained coding tools
  (`read_file`, `write_file`, `edit_file`, `list_directory`, `glob`,
  `grep`, `run_command`).
- `packages/workflow` — the YAML schema, the safe expression language, and
  the dependency-graph execution engine ([adr-0008](adrs/adr-0008.md));
  see [workflows.md](workflows.md).
- `packages/orchestrator` — the `Scheduler` (poll, trigger/eligibility,
  claim), `RunCoordinator` (workspace prep → engine execution → delivery →
  cleanup, for one claimed item), agent routing, the command runner, and
  the workflow-action registry.

**Isolation and delivery**

- `packages/workspaces` — the four workspace strategies (git-worktree,
  git-clone, local-directory, temp-directory) and their path-safety
  guarantees ([adr-0009](adrs/adr-0009.md)).
- `packages/scm-git` — local git operations and GitHub pull-request
  creation (via the `gh` CLI).

**Cross-cutting**

- `packages/config` — the layered YAML configuration schema and loader;
  see [configuration.md](configuration.md).
- `packages/secrets` — OS-native credential storage (macOS Keychain, Linux
  Secret Service) with an encrypted-file fallback, plus log redaction
  ([adr-0015](adrs/adr-0015.md)).
- `packages/policy` — the rule-based `PolicyEngine` and approval gateway
  every tool call passes through.
- `packages/persistence` — `node:sqlite`-backed storage for runs, sessions,
  the append-only event log, claims, and usage ([adr-0010](adrs/adr-0010.md)).
- `packages/extensions` — the extension host, MCP client, skills loader,
  and hook registry; see [extending.md](extending.md) for exactly what's
  wired into the shipped daemon today versus what needs custom
  composition-root wiring.

**Providers** (`packages/providers/*`) — see [providers.md](providers.md)
for the full catalog: `model-anthropic`, `model-openai` (also serves
OpenAI-compatible endpoints, OpenRouter, and Ollama), `agent-claude-code`,
`agent-codex`, `agent-copilot`, `agent-discovery` (local CLI probing),
`work-github` (Issues and Projects v2), `work-jira-cloud`,
`work-jira-datacenter`, `work-linear`.

**Control plane and clients**

- `packages/server` — the local daemon: the loopback HTTP + SSE control
  plane ([adr-0011](adrs/adr-0011.md)).
- `packages/cli` — the `overture` CLI, and `daemon.ts`, the composition
  root that assembles every package above into a running service.
- `apps/desktop` — the Tauri v2 shell (`shell/`) that bundles the daemon as
  a supervised sidecar process, and the web UI (`ui/`) that speaks the same
  loopback API as the CLI ([adr-0012](adrs/adr-0012.md)).
- `packages/e2e` — end-to-end tests driving the real stack (a scripted
  model, real tools and git, a real local origin) through one full
  issue-to-pull-request run.

## ADRs by topic

| Topic | ADRs |
|---|---|
| Platform and repo structure | [0001](adrs/adr-0001.md) TypeScript/Node · [0002](adrs/adr-0002.md) pnpm monorepo |
| Core architecture | [0003](adrs/adr-0003.md) ports-and-adapters · [0004](adrs/adr-0004.md) run state machine & explicit completion · [0005](adrs/adr-0005.md) budgets · [0006](adrs/adr-0006.md) event bus |
| Orchestration | [0007](adrs/adr-0007.md) lifecycle & persisted claims · [0008](adrs/adr-0008.md) workflow engine · [0009](adrs/adr-0009.md) workspace isolation |
| Persistence | [0010](adrs/adr-0010.md) SQLite via `node:sqlite` |
| Process model | [0011](adrs/adr-0011.md) daemon + thin CLI/GUI clients · [0012](adrs/adr-0012.md) Tauri desktop shell |
| Providers, extensibility, security | [0013](adrs/adr-0013.md) provider authentication · [0014](adrs/adr-0014.md) MCP integration · [0015](adrs/adr-0015.md) secret storage |

## Observability: everything is an event

Every meaningful occurrence — work discovery, claiming, workspace
lifecycle, run state changes, workflow step start/completion, model
requests, tool calls, sub-agents, budget thresholds, approvals, delivery —
is published as one variant of the closed `OrchestratorEvent` union
(`packages/core/src/events.ts`) on the `EventBus` port. The default
implementation (`InMemoryEventBus`) is synchronous fan-out with handler
isolation: a throwing subscriber can't disrupt the publisher or any other
subscriber. Agent-session events (`agent.text`, `agent.tool.started`, …)
are wrapped as `{ type: 'agent', sessionId, event }` so the per-session
stream and the orchestrator-wide stream share one vocabulary.

Three consumers subscribe to the same bus, none coupled to the runtime
directly: the persistence layer's event log, the control plane's SSE
endpoint (`GET /api/events`, consumed by `overture events` and the desktop
UI), and — where wired — hook handlers. This is why the runtime package has
no dependency on `packages/server`, `packages/cli`, or `apps/desktop`.

## Process model

The orchestration core runs as a single long-lived Node process,
`overture daemon` ([adr-0011](adrs/adr-0011.md)): it loads configuration,
assembles every provider and the kernel (`packages/cli/src/daemon.ts` is
the composition root), starts the scheduler, and exposes a loopback HTTP +
SSE API on `127.0.0.1:43117` by default, guarded by a random bearer token
written to `daemon.json` in the state directory
(`$XDG_STATE_HOME/overture`, or `~/.local/state/overture`).

- **The CLI** (`overture ...`) is a thin client: every command except
  `daemon`, `secrets`, and `config validate` reads `daemon.json` to locate
  the running daemon and speaks its HTTP/SSE API — it holds no
  orchestration logic itself.
- **The desktop app** ([adr-0012](adrs/adr-0012.md)) is a Tauri v2 shell
  that bundles the same daemon build as a supervised sidecar process (spawn,
  health-check, restart on crash, graceful shutdown), and a web UI that
  talks to the daemon's loopback API — the same surface the CLI uses — not
  to Tauri IPC, except for OS-shell concerns (window, tray, notifications,
  updater).

This client/daemon seam is deliberately the same seam a future
remote/team control plane would use: the API is already JSON-over-HTTP
with token auth and an SSE stream; a hosted deployment is an adapter and
auth change, not a redesign.
