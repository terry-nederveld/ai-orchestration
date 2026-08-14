# Overture

Overture is a cross-platform autonomous agent orchestrator. It turns work
items from external systems — GitHub Issues, GitHub Projects, Jira Cloud,
Jira Data Center, Linear — into autonomous agent executions that plan,
implement, test, review, and deliver changes as Conventional Commits and
pull requests, running as a local daemon with a CLI and desktop UI as thin
clients of the same control plane.

Overture is provider-neutral by design: model providers (Anthropic, OpenAI,
OpenAI-compatible endpoints, OpenRouter, local models via Ollama),
coding-agent providers (Claude Code, Codex, GitHub Copilot CLI), work
providers, source-control providers, workspace isolation strategies, and
workflows all sit behind stable ports and are replaceable without touching
the orchestration core.

## Features

- **Declarative YAML workflows** — a dependency-graph engine with typed
  step kinds (agent goals, shell commands, registered actions, human
  approvals), retries, timeouts, and a small safe expression language; see
  [docs/workflows.md](docs/workflows.md).
- **Provider-neutral execution** — the same run can be driven by the native
  agent loop against any model provider, or delegated to Claude Code,
  Codex, or Copilot's own agent runtime, behind one contract.
- **Crash-safe orchestration** — an explicit run state machine, persisted
  claims, and restart recovery; no work item is silently double-run or lost.
- **Isolated, disposable workspaces** — per-run git worktrees (or clones,
  local directories, temp directories) with path-traversal-safe naming and
  configurable retention.
- **First-class budgets** — token, cost, wall-clock, iteration, and
  subscription-request limits are core domain concepts, not an
  afterthought bolted onto one provider.
- **Policy-gated tools** — every tool call, built-in or MCP-sourced, passes
  through the same rule-based permission engine before it touches a
  filesystem, process, or network connection.
- **Local-first control plane** — a single daemon exposes a loopback
  HTTP + SSE API; the CLI and desktop UI are both thin clients of it,
  headless operation by default.
- **No attribution noise** — commits and pull requests Overture creates are
  Conventional Commits with no AI-attribution trailers, enforced at the
  source-control layer.

## Quick Start

```sh
pnpm install
pnpm build
overture secrets set provider/anthropic/api-key   # value via stdin
overture daemon
```

See [docs/getting-started.md](docs/getting-started.md) for the full walkthrough:
configuring a work source, starting the daemon, and watching your first
run go from a labelled issue to an open pull request.

## Repository Layout

```
packages/    orchestration core, providers, runtime, workflow engine,
             orchestrator, workspaces, scm-git, secrets, policy,
             extensions, persistence, config, control plane (server), CLI
apps/        desktop application (Tauri shell + web UI)
docs/        guides, architecture decision records (docs/adrs/), progress ledger
```

See [docs/architecture.md](docs/architecture.md) for the full package map
and layer diagram.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## Documentation

- [Getting Started](docs/getting-started.md) — install, configure, run your
  first work item end to end.
- [Configuration Reference](docs/configuration.md) — the full config schema.
- [Authoring Workflows](docs/workflows.md) — the YAML format, expression
  language, and execution semantics.
- [Provider Catalog](docs/providers.md) — every model, agent, and work
  provider, and how to configure it.
- [Extending Overture](docs/extending.md) — adding a provider, tool,
  workflow action, or extension.
- [Architecture Overview](docs/architecture.md) — the one-page system map.
- [Security Model](docs/security.md) — what is enforced, what is trusted,
  and what you accept when enabling each feature.
- [Architecture Decision Records](docs/adrs/) — the full design record.
