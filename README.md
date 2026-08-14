# Overture

Overture is a cross-platform autonomous agent orchestrator. It turns work items
from external systems — GitHub Issues, GitHub Projects, Jira Cloud, Jira Data
Center, Linear — into autonomous agent executions that plan, implement, test,
review, and deliver changes as conventional commits and pull requests.

Overture is provider-neutral by design: model providers (Anthropic, OpenAI,
OpenAI-compatible endpoints, local models), coding-agent providers (Claude
Code, Codex, Copilot), work providers, source-control providers, workspace
strategies, and workflows all sit behind stable interfaces and are replaceable
without touching the orchestration core.

## Repository Layout

```
packages/    orchestration core, providers, runtime, CLI, control plane
apps/        desktop application
docs/        architecture decision records (docs/adrs/), progress ledger
```

## Development

```
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Documentation lives in `docs/`. Architectural decisions are recorded in
`docs/adrs/`.
