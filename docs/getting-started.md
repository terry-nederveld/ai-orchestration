# Getting Started

This walks through installing Overture, wiring up one model provider and one
work source, starting the daemon, and watching it pick up and run a work
item end to end.

## Prerequisites

- **Node.js ≥ 22** and **pnpm** (the repository pins `pnpm@10.15.1` via
  `packageManager` in `package.json`).
- **git**, on `PATH`.
- An API key for at least one model provider (Anthropic is the default —
  see [providers.md](providers.md) for OpenAI, OpenRouter, and Ollama).
- Optional, only if you want a subscription-backed coding-agent provider
  instead of the native runtime: the vendor's own CLI, already logged in —
  `claude` (Claude Code), `codex` (OpenAI Codex), or `copilot`/`gh` (GitHub
  Copilot CLI). Overture never implements these logins itself; it delegates
  to whichever of these CLIs is already authenticated on your machine (see
  [providers.md](providers.md) and
  [adr-0013](adrs/adr-0013.md)).
- A `github` GitHub personal access token (or equivalent) if you want to
  pull work items from GitHub Issues, and `gh` authenticated locally
  (`gh auth login`) if you want Overture to open pull requests — pull
  request creation goes through the `gh` CLI, not a configured token.

## Install and build

```sh
git clone <your-fork-or-clone-url> overture
cd overture
pnpm install
pnpm build
```

This builds every package under `packages/` (`pnpm -r --filter './packages/**' run build`,
per the root `package.json`). The CLI entry point is
`packages/cli/dist/main.js`, exposed as the `overture` binary via that
package's `bin` field. Until you link it globally, invoke it directly:

```sh
node packages/cli/dist/main.js <command>
```

To get a real `overture` command on your `PATH`, link the CLI package:

```sh
cd packages/cli
pnpm link --global
cd ../..
overture help
```

The rest of this guide uses `overture` — substitute
`node packages/cli/dist/main.js` if you haven't linked it.

## Store your API key

Secrets are never written into configuration files — they live in your OS
keychain (macOS Keychain via the `security` CLI, Linux Secret Service via
`secret-tool`, or an AES-256-GCM encrypted file fallback when neither is
available; see [adr-0015](adrs/adr-0015.md)). Config files reference secrets
by name only.

```sh
overture secrets set provider/anthropic/api-key
```

`secrets set` reads the value from **stdin**, so pipe it in rather than
passing it as an argument (it never touches shell history or `ps`):

```sh
echo -n "sk-ant-..." | overture secrets set provider/anthropic/api-key
```

If you're pulling work items from GitHub, also store a token:

```sh
echo -n "ghp_..." | overture secrets set work/github/token
```

These two names — `provider/<id>/api-key` and `work/<id>/token` — are the
defaults Overture resolves automatically when a `providers.<id>` or
`work[].id` entry doesn't set an explicit `apiKeySecret` / `tokenSecret`
(see [configuration.md](configuration.md)).

## Write a minimal config

Overture reads `~/.config/overture/config.yaml` (or
`$XDG_CONFIG_HOME/overture/config.yaml`) as the user layer, and
`.overture/config.yaml` inside a project directory as a project layer that
overrides it. For a first run, the user config is enough:

```yaml
# ~/.config/overture/config.yaml
providers:
  anthropic:
    defaultModel: claude-sonnet-4-5

routing:
  defaultProfile: default
  profiles:
    default:
      executor: native-anthropic
      model: claude-sonnet-4-5

work:
  - id: github
    type: github
    container: your-org/your-repo   # owner/name
    tokenSecret: work/github/token
```

`providers.anthropic.apiKeySecret` is omitted deliberately — it defaults to
`provider/anthropic/api-key`, the name you already stored. See
[configuration.md](configuration.md) for the full schema, every section, and
what each field actually does at runtime today.

If you'd rather use a locally authenticated coding-agent CLI (Claude Code,
Codex, or Copilot) instead of direct API calls, point a routing profile's
`executor` at `claude-code`, `codex`, or `copilot` instead of
`native-anthropic` — these are wired in automatically with `cli-session`
authentication whenever the corresponding CLI is installed, no extra config
needed.

## Start the daemon

```sh
overture daemon
```

This assembles the full service from your config, starts the loopback HTTP
control plane (default `127.0.0.1:43117`), writes a per-install auth token
and connection info to `daemon.json` in the state directory
(`$XDG_STATE_HOME/overture`, or `~/.local/state/overture`), and begins
polling configured work sources every `orchestrator.pollIntervalMs`
(default 60s). Leave it running in this terminal, or run it under your
process supervisor of choice; every other `overture` command talks to it
over that loopback API.

In another terminal, confirm it's up:

```sh
overture status
overture providers
```

`overture providers` reports, per configured provider, whether it's
installed, authenticated, and available — useful for catching a missing key
or an unauthenticated CLI before you wait on a poll cycle.

On first boot the daemon also installs and enables the **template
catalog** — the `autonomous-delivery` and `autonomous-discovery` durable
graph workflows, with their gate sets, rubric, experiment, and default
profiles (see [durable-workflows.md](durable-workflows.md)). Confirm
with:

```sh
overture definitions list
```

and disable anything you don't want startable with
`overture definitions disable workflow autonomous-discovery` — the
daemon respects that on later boots. Durable graph runs suspend on
human questions instead of failing; check and answer them with
`overture waits list` / `overture waits respond <id> --value <v>`, and
inspect a graph run's position with `overture graph-run show <run-id>`.

## Trigger a run

The workflow shipped as Overture's default — `software-development` — plans,
implements, tests, reviews (with one remediation-and-re-review pass), and
opens a pull request unattended (see [workflows.md](workflows.md) for the
full annotated walkthrough). Its trigger and eligibility, exactly as shipped
(`packages/workflow/src/builtin-workflows.ts`), are:

```yaml
trigger:
  states: [Ready for Agent]
eligibility:
  labels:
    include: [agent-ready]
    exclude: [blocked]
  types: [bug, feature, chore]
```

**A note on GitHub specifically**: GitHub Issues has no native state beyond
`open`/`closed` and no native "type" field. The GitHub work-source wiring
shipped today doesn't expose a way to map an issue label onto a custom state
name, so the built-in workflow's `Ready for Agent` state trigger and
`types: [bug, feature, chore]` eligibility gate can't currently be satisfied
by a GitHub-sourced item — only the `agent-ready` label check can. If your
work source is GitHub, define your own workflow instead, gated on the label
alone. Save it as a project file so it's versioned with your repository:

```yaml
# .overture/workflow.yaml
name: github-agent-ready
description: Pick up any open GitHub issue labelled agent-ready.

trigger:
  labels: [agent-ready]

eligibility:
  labels:
    exclude: [blocked]

workspace:
  strategy: git-worktree
  retention: on-failure

variables:
  test_command: npm test

steps:
  - id: analyze
    agent: planner
    goal: >-
      Read the linked work item and repository context, then produce an
      implementation plan. Output a title and a plan as step outputs.
    route: default
    max_turns: 20

  - id: implement
    agent: coder
    depends_on: [analyze]
    goal: >-
      Implement the plan. Make the smallest correct change that satisfies
      the acceptance criteria, following repository conventions. Commit
      using Conventional Commits.
    route: default
    max_turns: 40

  - id: test
    command: ${{ vars.test_command }}
    depends_on: [implement]
    timeout: 10m

  - id: deliver
    action: source_control.pull_request
    depends_on: [test]
    with:
      title: ${{ steps.analyze.outputs.title }}
      body: ${{ steps.analyze.outputs.plan }}

transitions:
  success: closed
```

Give a project workflow a name other than `software-development` so it adds
to, rather than replaces, the built-in one — see
[workflows.md](workflows.md) for how workflow files from different
locations are composed and how naming collisions are resolved. Restart the
daemon (or wait for the next poll — workflow files are read fresh on each
scheduler tick) after adding this file.

Now label an issue in your configured repository `agent-ready`. On the next
poll, Overture will discover it, claim it (a `overture:claimed` label plus
an HTML-comment marker recording which run holds the claim), create an
isolated git worktree, and start running the workflow.

## Watch it happen

```sh
overture events
```

streams the live event feed (work discovery, claims, workspace creation,
run state changes, workflow step start/completion, model requests, budget
warnings, delivery). Follow one run in particular:

```sh
overture runs                 # find the run id
overture events --run <id>
overture runs show <id>
```

If the run opens a pull request, its URL comes through as a
`delivery.pull_request.created` event and is also visible via
`overture runs show <id>`.

## Where to go next

- [configuration.md](configuration.md) — the full config schema, every
  section, and an honest account of which knobs the daemon currently reads.
- [workflows.md](workflows.md) — the v1 YAML format, expression language,
  and execution semantics, with the built-in workflow annotated step by
  step.
- [durable-workflows.md](durable-workflows.md) — the durable graph model:
  versioned definitions, gates, durable waits and human input,
  checkpoints, profiles, experiments, lanes and schedules, routing, the
  shipped templates, and side-effect-free Evaluate.
- [providers.md](providers.md) — every model, agent, and work provider:
  what each needs, and the exact config to wire it up.
- [extending.md](extending.md) — adding a new provider, tool, workflow
  action, or extension.
- [architecture.md](architecture.md) — the one-page system overview.
