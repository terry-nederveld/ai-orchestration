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

### The durable graph runtime (Phase 2)

Alongside the v1 poll-and-claim pipeline above, the daemon assembles a
second execution path for **durable graph workflows**
([adr-0017](adrs/adr-0017.md), reference: [durable-workflows.md](durable-workflows.md)):

```
  lanes / schedules / routing  ──────────▶  GraphScheduler
  (backlog rank, cron, human selection)   (orchestrator/src/scheduling)
                                                  │ claim + start
                                                  ▼
   definition store ──resolve + pin──▶  GraphRunCoordinator ◀──waits API──
   (versioned, content-addressed,       (orchestrator/src/graph)          │
    immutable run snapshots)                      │ tick                  │
                                                  ▼                       │
                                     Graph Engine (workflow/src/graph-engine)
                                     resumable reducer over persisted state
                                                  │
                    agent / command / action / gate / human-input / wait /
                    subworkflow / fan-out / experiment / terminal executors
                                                  │
                            suspend ──▶ durable WaitCondition + checkpoint
                                        (git branch or work-item section)
```

Execution is **tick-based**: the engine is a pure, resumable reducer —
one tick executes runnable nodes, settles results, fires declared
transitions, and returns; the coordinator persists the graph state after
every tick and converts engine waits into durable rows. A run can
therefore suspend for days, survive restarts (`recover()` re-drives
interrupted runs from persisted state), and resume from its exact graph
position when a wait is satisfied. Runs execute against an immutable
snapshot of every definition they reference, pinned at start
([adr-0018](adrs/adr-0018.md)).

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
  see [workflows.md](workflows.md). Also hosts the **graph engine**
  (`src/graph-engine/`): the durable tick reducer, the scope-expression
  language shared by transitions/guards/gates/routing, and the v1 → graph
  compiler ([adr-0017](adrs/adr-0017.md)).
- `packages/orchestrator` — the `Scheduler` (poll, trigger/eligibility,
  claim), `RunCoordinator` (workspace prep → engine execution → delivery →
  cleanup, for one claimed item), agent routing, the command runner, and
  the workflow-action registry. Also hosts the graph runtime's
  orchestration (`src/graph/`): the `GraphRunCoordinator` (snapshot
  pinning, ticks, durable waits, checkpoints, spec revisions, child runs),
  node executors, the `SnapshotResolver`, the `DefaultSpecBuilder`, the
  side-effect-free `evaluateWorkflow` ([adr-0026](adrs/adr-0026.md)), and
  the experiment stepper — plus lane/schedule/routing dispatch
  (`src/scheduling/`: `GraphScheduler`, routing rules and rule learning;
  [adr-0023](adrs/adr-0023.md), [adr-0024](adrs/adr-0024.md)).

**Durable graph runtime** (Phase 2; see
[durable-workflows.md](durable-workflows.md))

- `packages/checkpoints` — the two shipped checkpoint strategies
  ([adr-0020](adrs/adr-0020.md)): `git-branch` (WIP commit + push, restore
  as a fresh worktree from the remote branch) for coding runs, and
  `work-item-section` (a delimiter-managed section of the work item's
  description, human content never overwritten) for non-code runs.
- `packages/resolution` — convention-file instruction discovery
  (CLAUDE.md, AGENTS.md, AGENT.md, copilot-instructions, with scope and
  precedence) and composable context resolvers assembled under an
  explicit budget.
- `packages/experiments` — the resumable experiment state machine
  (generate → prototype → evaluate → select → human judgment, bounded
  iteration; [adr-0022](adrs/adr-0022.md)) and durable learning capture
  rendered as markdown.
- `packages/templates` — the versioned template catalog: the flagship
  Autonomous Delivery and Autonomous Discovery graph workflows with
  their gate sets, rubric, experiment, and default profiles; installed
  idempotently into the definition store by the daemon on boot.

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
| Providers, extensibility, security | [0013](adrs/adr-0013.md) provider authentication · [0014](adrs/adr-0014.md) MCP integration · [0015](adrs/adr-0015.md) secret storage · [0016](adrs/adr-0016.md) v1 security hardening |
| Durable graph runtime | [0017](adrs/adr-0017.md) graph model & four state layers · [0018](adrs/adr-0018.md) versioned definitions & run snapshots · [0019](adrs/adr-0019.md) durable waits & human input · [0020](adrs/adr-0020.md) execution specs & checkpoints |
| Profiles, experiments, scheduling | [0021](adrs/adr-0021.md) composable profiles & fallback chains · [0022](adrs/adr-0022.md) experiments & pinned rubrics · [0023](adrs/adr-0023.md) lanes & durable recurrence · [0024](adrs/adr-0024.md) routing & rule learning |
| Clients and tooling | [0025](adrs/adr-0025.md) federated desktop client · [0026](adrs/adr-0026.md) designer & side-effect-free Evaluate |

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
