# Configuration Reference

Overture's configuration is a single YAML document validated against a Zod
schema (`packages/config/src/schema.ts`). This page documents every field,
its type, its default, a complete example, and — because several sections
are validated but not yet consumed by the shipped daemon — an honest note on
what actually takes effect today.

## File locations and layering

Configuration is loaded and merged in this order (`packages/config/src/layers.ts`):

1. **Schema defaults** — every field below has a default baked into the
   schema; an empty config file is valid.
2. **User config** — `$XDG_CONFIG_HOME/overture/config.yaml`, or
   `~/.config/overture/config.yaml` when `XDG_CONFIG_HOME` is unset.
3. **Project config** — `<project>/.overture/config.yaml`, loaded when the
   daemon is started with a project directory (running `overture daemon`
   from inside a project does this automatically).
4. **Runtime overrides** — an in-memory object a caller can pass to
   `loadConfig()`; the CLI and daemon don't currently expose a flag for
   this, but the loader supports it.

**Merge semantics**: plain objects merge deeply, key by key; arrays and
scalars are replaced wholesale, never concatenated. So a project config that
sets `work: [...]` replaces the user config's `work` array entirely rather
than appending to it, but a project config that sets `providers.anthropic.defaultModel`
only overrides that one field, leaving the rest of `providers.anthropic`
(and every other provider) untouched.

The fully merged document is validated once, against the whole schema, with
`.strict()` — unknown top-level or nested keys are a validation error, not
silently ignored. Validate a document standalone with:

```sh
overture config validate [file]
```

With no file argument, this validates the currently active layered config
(user + project, from the current working directory) and reports how many
layers were loaded. With a file argument, it validates that one file as a
complete document (schema defaults fill in anything omitted).

## Secrets are references, never values

Every credential-shaped field in this schema is a **secret name**
(`apiKeySecret`, `tokenSecret`), never a raw value. Secret values live in
OS-native credential storage — see [adr-0015](adrs/adr-0015.md) — and are
resolved at the point of use, never written to disk in config or logged.
Manage them with:

```sh
overture secrets set <name>      # value read from stdin
overture secrets list
overture secrets delete <name>
```

## Schema reference

### `providers`

`Record<string, ProviderConfig>` — one entry per model provider, keyed by
provider id (`anthropic`, `openai`, `openrouter`, `ollama`, or any other id
you choose for a generic OpenAI-compatible endpoint).

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set `false` to skip constructing this provider entirely. |
| `apiKeySecret` | `string` (secret name) | — | Defaults to `provider/<id>/api-key` when omitted. |
| `baseUrl` | `string` (URL) | — | Required for a generic OpenAI-compatible id (anything other than `anthropic`/`openai`/`openrouter`/`ollama`); optional override for the named ones. |
| `defaultModel` | `string` | — | Model id passed to the native runtime when a routing profile doesn't specify one. |
| `options` | `Record<string, unknown>` | `{}` | Free-form bag; currently unread by the daemon assembly for model providers. |

The daemon (`packages/cli/src/daemon.ts`) constructs a provider for every
enabled entry: `anthropic` → `AnthropicModelProvider`; `openai` →
`createOpenAIProvider`; `openrouter` → `createOpenRouterProvider`; `ollama` →
`createOllamaProvider` (or an OpenAI-compatible client against `baseUrl` if
you set one); any other id with a `baseUrl` set → a generic
`createOpenAICompatibleProvider`. An id with no `baseUrl` that isn't one of
the four named providers is skipped with a warning.

### `routing`

```yaml
routing:
  defaultProfile: default
  profiles:
    <name>:
      executor: <string>       # required
      model: <string>
      systemPrompt: <string>
      requires: [<string>]     # capability ids
```

`defaultProfile` (default `"default"`) names the profile used when a
workflow step's `route` (or its `agent` role name) doesn't match any
configured profile. `profiles.<name>.executor` must match a registered
executor id: `native-<provider-id>` for a directly-driven model provider
(e.g. `native-anthropic`), or `claude-code` / `codex` / `copilot` for the
corresponding agent-CLI provider — these three are always registered when
the daemon starts, regardless of config, using `cli-session` authentication
(they detect availability at call time; see
[providers.md](providers.md)).

If no profile exists for `routing.defaultProfile`, the daemon builds a
fallback at startup: it tries `claude-code` first (if detected available),
then the first configured model provider, so a bare install with one API
key and no routing config still works.

Note: `requires` is accepted by the schema and by `RouteProfile`
(capability-gated routing, checked at resolution time — an executor missing
a required capability fails fast), but the daemon's config-to-profile
translation currently copies only `executor`, `model`, and `systemPrompt`
from `routing.profiles.<name>` — `requires` set in YAML is not yet forwarded.

### `budgets`

```yaml
budgets:
  <name>:
    maxConcurrentAgents: <int>
    maxSubagentsPerRun: <int>
    maxIterations: <int>
    maxWallClockMs: <int>
    maxTokens: <int>
    maxEstimatedCostUsd: <number>
    maxSubscriptionRequests: <int>
    providerQuotas:
      <key>: <number>
```

A named map of `BudgetLimits` (every field optional; omitted means
unbounded on that dimension). Workflows reference a budget by name via
their top-level `budget:` field, and `orchestrator.defaultBudget` names the
fallback.

**Not yet wired**: `BudgetTracker` (`packages/core/src/budget.ts`) is fully
implemented and the native runtime enforces per-run `limits` when it
receives them, but the daemon assembly never reads `config.budgets` or
`config.orchestrator.defaultBudget` and never passes budget limits into
agent-step execution. Declaring a budget here is currently inert; each
agent step runs with only whatever `max_turns`/`timeout` its own workflow
step sets.

### `permissions`

```yaml
permissions:
  defaultEffect: deny        # allow | deny | ask | sandbox-only
  rules:
    - id: <string>
      capability: <string>   # a PermissionCapability id
      target: <glob>         # optional; matches the request target
      effect: allow          # allow | deny | ask | sandbox-only
```

Capability ids: `filesystem.read`, `filesystem.write`, `process.execute`,
`network.connect`, `git.read`, `git.write`, `issue.read`, `issue.write`,
`secret.read`, `browser.use`, `computer.use`, `container.use`
(`packages/core/src/permissions.ts`).

Rules are evaluated in order; the first matching rule (by capability, then
by glob-matched `target` — `*` within a path segment, `**` across
segments) wins. No match falls back to `defaultEffect`. Configured rules
are checked **before** a built-in preset — `workspaceCodingRules()` — that
allows filesystem read/write, process execution, git read/write, and issue
read/write unconditionally, so your rules can tighten or override any of
those seven, but everything else (network, secrets, browser, computer,
container use — which includes every MCP tool, since MCP tools declare
`network.connect`) is denied by default until you add a rule for it.

### `workspaces`

```yaml
workspaces:
  root: <path>            # default: <state-dir>/workspaces
  reposRoot: <path>       # default: <state-dir>/repos
  defaultStrategy: git-worktree
  retention: on-failure    # always | on-failure | never
```

`root` and `reposRoot` are read and used to construct the workspace
providers. **`defaultStrategy` and `retention` here are currently not
read** — every run's actual strategy and retention come from the
*workflow's own* `workspace.strategy` / `workspace.retention` fields
(defaulting, in code, to `git-worktree` / `on-failure` when a workflow
omits them), not from this config section. Set retention per workflow; see
[workflows.md](workflows.md).

### `work`

```yaml
work:
  - id: <string>              # required; also the default secret-name segment
    type: <string>            # required: github | jira-cloud | jira-datacenter | linear
    container: <string>       # repo (owner/name) | Jira project key | Linear team key
    tokenSecret: <string>     # default: work/<id>/token
    baseUrl: <url>            # Jira Cloud site / Jira Data Center base URL
    query: {}                 # unused by any shipped work provider today
    options: {}                # provider-specific extras (see below)
```

An array; the scheduler polls every entry every `orchestrator.pollIntervalMs`.
Field meaning is provider-specific — see [providers.md](providers.md) for
the full breakdown per provider (auth shape, what `container` and `baseUrl`
mean for each, and claim/transition semantics). One notable gap: Jira
Cloud's email (for basic auth) is read from the untyped `options.email` key
(`daemon.ts`), not a first-class schema field — a typo there silently
produces an empty email and an authentication failure.

### `mcp`

```yaml
mcp:
  servers:
    - name: <string>
      transport: stdio           # stdio | http
      command: <string>          # stdio only
      args: [<string>]
      url: <url>                 # http only
      env: {}                    # stdio: subprocess env
      headers: {}                # http: request headers
      scope: global               # global | project | workflow
```

MCP client support (`packages/extensions/src/mcp.ts`) is fully implemented
against the official `@modelcontextprotocol/sdk` — stdio and Streamable
HTTP transports, tools namespaced `mcp_<server>_<tool>`, routed through the
same permission pipeline as built-in tools (every MCP tool requires
`network.connect`). **This section is parsed and validated but not yet
wired into the running daemon** — nothing in `packages/cli/src/daemon.ts`
constructs an MCP client from it yet. See [extending.md](extending.md) for
how to wire it in a custom composition root today. Note also that remote
`http` servers currently only support static `headers`; the SDK's OAuth
helpers mentioned in [adr-0014](adrs/adr-0014.md) are not yet integrated.

### `extensions`

```yaml
extensions:
  paths: [<string>]   # directories to scan for extensions
```

Each path is expected to contain one subdirectory per extension, each with
a `manifest.json` and an `index.js` entry point — see
[extending.md](extending.md) for the format. **Parsed but not yet wired**:
nothing in the daemon assembly constructs a `DirectoryExtensionProvider`
from these paths today.

### `skills`

```yaml
skills:
  paths: [<string>]   # directories of *.md skill files
```

Each directory is scanned (non-recursively) for `.md` files with YAML
frontmatter (`name`, `description`, `scope` — one of `global`, `user`,
`project`, `workflow`, `agent`). **Parsed but not yet wired** into the
daemon today; see [extending.md](extending.md).

### `agents`

```yaml
agents:
  <role>:
    systemPrompt: <string>
    route: <string>
    toolNames: [<string>]
    maxTurns: <int>
```

Intended as reusable per-role defaults (planner/coder/reviewer/…) layered
under a workflow step's own `route`/`tool_names`/`max_turns`. **Parsed but
not yet consumed** — a workflow step's `agent:` field is used only as a
free-text role label passed to the model as context and as a routing key
(`step.route ?? step.agent`); there is no lookup into `config.agents` today.
Set per-step routing, tools, and turn limits directly in the workflow YAML
instead (see [workflows.md](workflows.md)).

### `mapping`

```yaml
mapping:
  rules:
    - id: <string>               # required
      priority: <int>            # default 0; higher wins on conflict
      when: <predicate>          # required; see below
      repositories:              # required, at least one
        - locator: <string>      # e.g. acme/widgets
          role: primary          # primary | frontend | backend | infra | docs | dependency
          defaultBranch: <string>
          scmProviderId: <string>
      onConflict: replace        # replace | merge (default: merge)
```

Declarative work-item → repository mapping for the durable graph runtime
(`packages/core/src/mapping.ts`; schema in
`packages/config/src/schema.ts`). When a graph run starts, the
`DefaultSpecBuilder` (`packages/orchestrator/src/graph/spec-builder.ts`)
resolves which repositories the run works against and records each with
its role and provenance in the run's execution specification. Explicit
repository metadata on the work item itself always wins (recorded as
`resolvedBy: explicit`); these rules are the second resolution path
(`resolvedBy: rule:<id>`).

`when` is a recursive predicate: `{ condition: {...} }` at the leaves,
combined with `{ all: [...] }`, `{ any: [...] }`, and `{ not: ... }`. A
condition has a `field` (dotted path over the work item: `provider`,
`externalId`, `title`, `state`, `type`, `priority`, `labels`,
`metadata.<key>`, `parent.<field>`, `relationships.<kind>`), an
`operator` (`equals`, `in`, `contains`, `regex`), and a `value` (string,
or string array for `in`).

Resolution is deterministic: rules sort by `priority` descending (ties by
declaration order); every matching rule contributes its repositories
(deduplicated by locator + role); a matching rule with
`onConflict: replace` contributes and then discards everything below it.

```yaml
mapping:
  rules:
    - id: billing-items
      priority: 10
      when:
        all:
          - condition: { field: labels, operator: equals, value: billing }
          - not:
              condition: { field: type, operator: equals, value: epic }
      repositories:
        - { locator: acme/billing-api, role: primary }
        - { locator: acme/billing-web, role: frontend }
      onConflict: replace
    - id: default-repo
      priority: 0
      when:
        condition: { field: provider, operator: equals, value: github }
      repositories:
        - { locator: acme/widgets, role: primary }
```

An item with neither explicit metadata nor a matching rule resolves to
no repositories — its execution specification simply records none, and
a dry-run via Evaluate reports a `no-repository` blocker when the
workflow requires a workspace
(see [durable-workflows.md](durable-workflows.md)).

### `orchestrator`

```yaml
orchestrator:
  maxConcurrentRuns: 2
  pollIntervalMs: 60000
  claimant: overture
  branchPrefix: overture
  defaultBudget: default
  workflowsDir: <path>       # optional
```

All fields except `defaultBudget` are read and active: `maxConcurrentRuns`
bounds how many runs the scheduler dispatches at once; `pollIntervalMs` is
the discovery-cycle interval; `claimant` is the identity recorded in
external claim markers (issue comments) and is also this orchestrator
instance's name for the authoritative in-process `ClaimStore`;
`branchPrefix` prefixes every run's git branch (`<prefix>/<slugified-item-id>`);
`workflowsDir`, if set, is scanned (as `*.yaml`/`*.yml`) for additional
workflow definitions alongside the built-in one and any project
`.overture/*.yaml` files. `defaultBudget` is parsed but not yet consumed
(see `budgets` above).

### `daemon`

```yaml
daemon:
  port: 43117
  host: 127.0.0.1
```

The loopback HTTP control-plane bind address and port. `overture daemon
--port <n>` overrides `daemon.port` at the CLI without editing config.

**Template install on boot.** On every start, the daemon installs the
template catalog (`packages/templates/src` — Autonomous Delivery and
Autonomous Discovery with their gate sets, rubric, experiment, and
default profiles) into the definition store
(`packages/cli/src/daemon.ts`). Installation is idempotent: documents
are content-addressed, so an unchanged template mints no new version. A
freshly installed definition (lifecycle `draft`) is enabled
automatically; a definition an operator has since `disable`d stays
disabled — the daemon never overrides that. There is no config knob for
this; manage the installed definitions with
`overture definitions list|enable|disable`
(see [durable-workflows.md](durable-workflows.md)).

## Complete example

```yaml
providers:
  anthropic:
    defaultModel: claude-sonnet-4-5
  openai:
    enabled: false

routing:
  defaultProfile: default
  profiles:
    default:
      executor: native-anthropic
      model: claude-sonnet-4-5
    reviewer:
      executor: claude-code

budgets:
  default:
    maxTokens: 2000000
    maxEstimatedCostUsd: 20
    maxWallClockMs: 3600000
    maxIterations: 60

permissions:
  defaultEffect: deny
  rules:
    - id: no-force-push
      capability: git.write
      target: "push --force*"
      effect: deny
    - id: allow-mcp
      capability: network.connect
      effect: allow

workspaces:
  root: /var/lib/overture/workspaces
  reposRoot: /var/lib/overture/repos
  defaultStrategy: git-worktree
  retention: on-failure

work:
  - id: github
    type: github
    container: acme/widgets
    tokenSecret: work/github/token
  - id: jira
    type: jira-cloud
    baseUrl: https://acme.atlassian.net
    container: WID
    tokenSecret: work/jira/token
    options:
      email: bot@acme.com

mapping:
  rules:
    - id: default-repo
      priority: 0
      when:
        condition: { field: provider, operator: equals, value: github }
      repositories:
        - { locator: acme/widgets, role: primary }

mcp:
  servers:
    - name: docs
      transport: http
      url: https://mcp.example.com/sse
      scope: global

extensions:
  paths:
    - /etc/overture/extensions

skills:
  paths:
    - /etc/overture/skills

orchestrator:
  maxConcurrentRuns: 3
  pollIntervalMs: 30000
  claimant: overture-prod
  branchPrefix: overture
  workflowsDir: /etc/overture/workflows

daemon:
  port: 43117
  host: 127.0.0.1
```
