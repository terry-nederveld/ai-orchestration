# Provider Catalog

Overture separates three provider families behind stable interfaces
(`packages/core/src`): **model providers** (direct LLM inference),
**agent providers** (external coding-agent runtimes with their own loop),
and **work providers** (external trackers). A fourth, narrower family,
**source-control providers**, handles git operations and pull requests.
This page documents every one shipped today, what each needs, and the exact
config to wire it up. See [configuration.md](configuration.md) for the full
schema and [extending.md](extending.md) to add a new one.

## Model providers

Configured under `providers.<id>` (see [configuration.md](configuration.md)).
Every model provider authenticates with `api-key` only.

### Anthropic

```yaml
providers:
  anthropic:
    defaultModel: claude-sonnet-4-5
    apiKeySecret: provider/anthropic/api-key   # this is the default; omit to use it
```

Talks directly to the Anthropic Messages API (raw `fetch`, no SDK
dependency) — full tool use, vision, streaming, reasoning, structured
output, and long-context capability. Store the key with
`overture secrets set provider/anthropic/api-key`.

### OpenAI

```yaml
providers:
  openai:
    defaultModel: gpt-5
```

Talks to `https://api.openai.com/v1` via the Chat Completions wire format.
Secret defaults to `provider/openai/api-key`.

### OpenRouter

```yaml
providers:
  openrouter:
    defaultModel: anthropic/claude-sonnet-4.5
```

Same client as OpenAI, pointed at `https://openrouter.ai/api/v1`. Secret
defaults to `provider/openrouter/api-key`.

### Ollama (local)

```yaml
providers:
  ollama:
    defaultModel: llama3.1
```

Talks to a local Ollama server's OpenAI-compatible endpoint
(`http://localhost:11434/v1` by default, or your `baseUrl`). No
authentication required — `consumption: local`.

### Any other OpenAI-compatible endpoint

Any `providers.<id>` entry with a `baseUrl` set that isn't one of the four
names above is wired as a generic OpenAI-compatible client:

```yaml
providers:
  vllm:
    baseUrl: http://localhost:8000/v1
    defaultModel: my-local-model
```

## Agent providers

Agent providers run an entire coding session themselves — planning, tool
use, and completion — rather than being driven turn-by-turn by Overture's
native runtime. All three are **always registered** when the daemon starts
(`packages/cli/src/daemon.ts`), independent of any `providers.<id>` config
entry; select one by pointing a `routing.profiles.<name>.executor` at
`claude-code`, `codex`, or `copilot`. None of them read config for their
own construction today — the daemon always builds them with
`auth: { kind: 'cli-session' }`; the `api-key` auth strategy each supports
in code is available to embedders but not exposed as a config option yet.

Per [adr-0013](adrs/adr-0013.md), Overture never implements a vendor's
consumer login itself. Subscription use is entirely delegated to the
vendor's own already-authenticated CLI.

### Claude Code

```yaml
routing:
  profiles:
    coder:
      executor: claude-code
```

Backed by `@anthropic-ai/claude-agent-sdk`, which drives the `claude` CLI.
Two auth strategies (`ClaudeCodeAuth`):

- **`cli-session`** (what the daemon uses today) — delegates to your local
  `claude` login. `detect()` runs `claude --version`; availability means
  installed, not necessarily logged in. The adapter strips any ambient
  `ANTHROPIC_API_KEY` from the subprocess environment so it can never
  silently override your subscription session (a documented Anthropic SDK
  behavior).
- **`api-key`** — resolves a key and sets `ANTHROPIC_API_KEY` explicitly on
  the subprocess.

Richest capability set of the three: tool use, parallel tool use,
streaming, MCP, skills, hooks, subagents, session resume, context
compaction, code execution. Its permission mode defaults to `acceptEdits`
(auto-accepts file edits, still prompts for other dangerous operations);
unattended runs typically need `bypassPermissions` instead, which skips
every SDK-level permission check and relies entirely on workspace
isolation — an embedder's choice, not currently exposed via config.

**ToS note** (adr-0013): Anthropic's docs prohibit third-party products from
offering claude.ai login/rate limits without approval. Overture never
attempts this — it only drives your own pre-authenticated `claude` CLI
session, the same way any other local tool would.

### Codex

```yaml
routing:
  profiles:
    coder:
      executor: codex
```

Drives the `codex` CLI directly and headlessly (`codex exec --json`,
argument-array spawn, JSONL on stdout — no `@openai/codex-sdk` dependency).
Same two auth strategies as Claude Code (`cli-session` delegates to `codex
login`'s stored auth and strips ambient `OPENAI_API_KEY`; `api-key` sets it
explicitly). `detect()` runs `codex login status` and checks for "logged
in" in the output. Capabilities: tool use, streaming, code execution,
session resume — no parallel tool use, MCP, skills, or hooks surfaced
through this adapter. Sandbox mode defaults to `workspace-write` (also
supports `read-only` and `danger-full-access`); Overture always passes
`--skip-git-repo-check` since it owns workspace isolation itself.

### GitHub Copilot CLI

```yaml
routing:
  profiles:
    coder:
      executor: copilot
```

Drives `copilot -p "<prompt>" --allow-all-tools`. Deliberately the
simplest and most conservative of the three adapters: the CLI's headless
output is unstructured text, so this adapter reports only `agent.text`
events — no per-tool-call visibility, no turn boundaries, no token/cost
usage (the CLI doesn't emit figures), and no session resume. Capabilities
are declared conservatively (chat + streaming only) to reflect that.
`cli-session` auth relies on the ambient `gh`/Copilot CLI session; `api-key`
auth sets `COPILOT_GITHUB_TOKEN` explicitly. Prefer Claude Code or Codex
when you need structured tool visibility in the event stream.

## Work providers

Configured as entries in `work[]` (see [configuration.md](configuration.md)).
Claiming is always two-layered: the *authoritative* claim is an atomic
compare-and-set in Overture's own persistence layer, so two runs can never
work the same item concurrently even if a provider's own marker races. What
each provider does below is the *external*, best-effort visibility marker.

### GitHub Issues

```yaml
work:
  - id: github
    type: github
    container: acme/widgets      # owner/name
    tokenSecret: work/github/token
```

- **Auth**: a GitHub token (PAT or GitHub App token) with issue read/write
  scope, resolved from `tokenSecret` (default `work/github/token`).
- **State**: native GitHub issues have only `open`/`closed`. The adapter
  supports a `stateLabels` option (workflow-state-name → label) to model
  richer states as mutually-exclusive labels, but **this isn't exposed
  through the config schema today** — the daemon always constructs the
  provider with just `{token, repo}`, so discovered items report state as
  `open` or `closed` only. `type` is never populated (GitHub issues have no
  native type field this adapter maps).
- **Claiming**: adds a `overture:claimed` label plus a marker HTML comment
  recording the claimant and run id; best-effort-assigns you as assignee.
- **Transitioning**: `open`/`closed` map to the native issue state; any
  other target requires a configured `stateLabels` entry (see above — not
  reachable via config as shipped).
- **Delivery**: pull requests are **not** created via this provider's
  token. `source_control.pull_request` goes through the GitHub
  source-control provider, which shells out to the `gh` CLI and requires
  `gh auth login` on the host — a separate authentication path from
  `work/github/token`.

### GitHub Projects (v2)

Implemented (`GitHubProjectsWorkProvider`, provider id `github-projects`,
GraphQL-only) but **not currently reachable through `work[].type`** — the
daemon's config-to-provider switch only recognizes `github`,
`jira-cloud`, `jira-datacenter`, and `linear`. Wiring a `github-projects`
entry requires an embedder to construct it directly (see
[extending.md](extending.md)). Its state comes from a configurable
single-select field (default `"Status"`); claiming is comment-marker-based
(draft items, which have no underlying issue, aren't claimable or
commentable at all).

### Jira Cloud

```yaml
work:
  - id: jira
    type: jira-cloud
    baseUrl: https://acme.atlassian.net   # or just "acme"
    container: WID                          # project key
    tokenSecret: work/jira/token
    options:
      email: bot@acme.com
```

- **Auth**: HTTP Basic (`email` + API token) or a Bearer OAuth token. Basic
  auth's email comes from the untyped `options.email` key — there's no
  first-class schema field for it, so a typo silently produces an empty
  email and an auth failure. `apiToken`/`bearer` value resolves from
  `tokenSecret`.
- **Discovery**: builds JQL from the query (`project`, `status IN (...)`,
  label include/exclude, assignee), or pass `query.nativeQuery` for raw
  JQL. Paginates via Jira's cursor-based `/search/jql` endpoint.
- **Claiming**: a label (default `overture-claimed`) plus a marker comment;
  does not disambiguate *who* holds an existing claim label the way Linear
  does.
- **Transitioning**: matches `targetState` **case-insensitively** against
  either the transition's destination status name or the transition's own
  name, then executes that transition by id.
- **Bodies**: description/comments are Atlassian Document Format; the
  adapter converts ADF→plain text on read and wraps plain text in a minimal
  single-paragraph ADF document on write.

### Jira Data Center

```yaml
work:
  - id: jira-dc
    type: jira-datacenter
    baseUrl: https://jira.internal.acme.com
    container: WID
    tokenSecret: work/jira-dc/token
```

Same shape as Jira Cloud with three differences: auth is a Personal Access
Token (Bearer) or username+password (Basic), never OAuth; the REST API
path is `/rest/api/2` (Cloud uses `/rest/api/3`) with classic
`startAt`/`maxResults` offset pagination (`/search`, not `/search/jql`);
and description/comment bodies are **plain strings**, never ADF.

### Linear

```yaml
work:
  - id: linear
    type: linear
    container: ENG              # team key
    tokenSecret: work/linear/token
```

- **Auth**: personal API key (raw in the `Authorization` header) or OAuth
  (`Bearer`-prefixed) — set via `authKind` at construction (not currently
  exposed through config; the daemon always uses `api-key`).
- **Claiming**: the most sophisticated of the four — a label (created on
  the team if it doesn't exist yet) *plus* a comment marker. If the label
  is already present, it re-reads the latest marker: if it names the same
  claimant, the claim is treated as already (idempotently) held; otherwise
  it reports `already-claimed` with the real claimant's name.
- **Transitioning**: workflow states are **per-team** in Linear. The
  adapter resolves the item's team from `metadata.teamKey` (set when the
  item came from this provider's own `discover()`/`get()`) or the
  configured team key, then matches `targetState` by **exact,
  case-sensitive** name — unlike Jira's case-insensitive match, worth
  remembering if you reuse workflow `transitions:` values across trackers.
- Items not sourced from this provider's own discovery (e.g. constructed by
  hand) will fail claim/comment/transition — they need
  `metadata.linearId`, Linear's internal UUID, distinct from the
  human-readable `externalId` like `ENG-123`.

## Source-control providers

Not user-configured directly — selected automatically per workspace/action.

- **`GitSourceControlProvider`** — local git only (clone, fetch, branch,
  status, diff, commit, push), via argv-array `git` invocations, no shell.
  Refuses to commit a message containing AI-attribution trailers
  (`Co-authored-by`, "Generated with…", etc.) — enforced at this layer,
  independent of any repository's own conventions.
- **`GitHubSourceControlProvider`** — adds `createPullRequest()`, entirely
  via the `gh` CLI. **Authentication is out-of-band**: `gh auth login` on
  the host machine; there is no `tokenSecret`-style config path feeding a
  token into this provider. PR titles and bodies pass through the same
  no-attribution check before creation.
