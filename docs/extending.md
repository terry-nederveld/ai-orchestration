# Extending Overture

Overture's core (`@overture/core`) defines vendor-neutral ports; every
integration is an adapter implementing one of them
([adr-0003](adrs/adr-0003.md)). This page covers each extension point: the
interface to implement, where it plugs into the running system, and which
contract tests to run against it. Code snippets are taken from or modelled
directly on the current source, so they compile against the contracts as
shipped.

A running theme below: several extension points (extensions, MCP, skills,
hooks beyond three call sites, and workflow actions contributed by an
extension) have a complete implementation but are **not yet constructed by
`packages/cli/src/daemon.ts`**, the composition root. Where that's the
case, this page says so explicitly and shows what wiring an integrator
needs to add.

## (a) A model provider

Implement `ModelProvider` (`packages/core/src/model.ts`):

```ts
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from '@overture/core'
import { Capability, CapabilitySet } from '@overture/core'

export class MyModelProvider implements ModelProvider {
  readonly info = {
    id: 'my-model',
    displayName: 'My Model',
    kind: 'model' as const,
    consumption: 'api-usage' as const,
    authentication: ['api-key' as const],
  }

  capabilities() {
    return CapabilitySet.of(Capability.Chat, Capability.ToolUse, Capability.Streaming)
  }

  async detect() { /* probe reachability + auth, return ProviderAvailability */ }
  async listModels() { /* return ModelInfo[] */ }
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> { /* ... */ }
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> { /* ... */ }
}
```

Map every HTTP/network failure onto `OrchestratorError`'s category taxonomy
(`packages/core/src/errors.ts`: `network`, `rate-limit`, `auth-expired`,
`quota-exhausted`, `timeout`, `provider-outage`, `invalid-input`,
`conflict`, `policy`, `capability-mismatch`, `corrupt-response`,
`internal`) — the orchestrator uses `category`/`retryable` to decide
whether to retry, not string matching. `AnthropicModelProvider`
(`packages/providers/model-anthropic/src/http-errors.ts`) is the reference
implementation for this mapping.

**Contract test**: `describeModelProviderContract`
(`packages/testkit/src/contracts/model-provider.contract.ts`) — pass it a
factory for your provider and it exercises the full port, including
streaming/non-streaming equivalence and error mapping.

**Wiring**: add a branch in the `providers` loop of
`packages/cli/src/daemon.ts` (mirrors the existing `anthropic`/`openai`/
`openrouter`/`ollama` branches), or — simpler, since any `providers.<id>`
entry with a `baseUrl` already gets a generic OpenAI-compatible client — if
your provider speaks the OpenAI Chat Completions wire format, you likely
need no new code at all; see `createOpenAICompatibleProvider` in
`packages/providers/model-openai/src/factories.ts`.

## (b) An agent provider

Implement `AgentProvider` (`packages/core/src/agent.ts`): `info`,
`capabilities()`, `detect()`, `start(request)` (and optionally `resume()`).
`start()` returns an `AgentRunHandle` — an `events(): AsyncIterable<AgentEvent>`
stream plus a `result(): Promise<AgentResult>` and `cancel()`. Map your
vendor's own event/output stream onto the closed `AgentEvent` union
(`agent.started`, `agent.turn.started`, `agent.text`, `agent.thinking`,
`agent.tool.started`/`completed`, `agent.subagent.started`/`completed`,
`agent.waiting.human`, `agent.usage`, `agent.completed`) and, critically,
onto the closed `AgentOutcome` set (`GOAL_COMPLETED`, `GOAL_BLOCKED`,
`BUDGET_EXHAUSTED`, `POLICY_BLOCKED`, `HUMAN_INPUT_REQUIRED`,
`FATAL_FAILURE`, `CANCELLED`) — text output alone is never completion
([adr-0004](adrs/adr-0004.md)). `packages/providers/agent-codex/src/provider.ts`
is a good reference: it maps a JSONL event stream and process exit code
onto exactly these outcomes.

Follow the established auth pattern (`ClaudeCodeAuth`/`CodexAuth`/
`CopilotAuth`): a discriminated union of `{kind: 'cli-session'}` (delegate
to the vendor's own authenticated CLI, and strip any ambient API-key env
var from the child process so it can never silently override a
subscription session) and `{kind: 'api-key', apiKey: () => Promise<string|undefined>}`.

**Contract test**: none exists yet — `packages/testkit` has no
`describeAgentProviderContract`. Write your own tests against the three
shipped adapters' `*.test.ts` files as a model; at minimum, assert every
possible terminal state maps to exactly one `AgentOutcome`.

**Wiring**: construct it in `packages/cli/src/daemon.ts` alongside
`claudeCode`/`codex`/`copilot` and `router.register({ id, start, capabilities })`.

## (c) A work provider

Implement `WorkProvider` (`packages/core/src/work.ts`): `detect`,
`discover(query)`, `get(externalId, container?)`, `claim`, `release`,
`comment`, `transition`, `listStates`. Remember claiming here is
**best-effort visibility only** — the authoritative, crash-safe claim
happens in the kernel's `ClaimStore`; your `claim()` just needs to leave an
external marker a human or another tool would recognize (a label, a
comment, an assignee — see the four shipped providers in
[providers.md](providers.md) for three different approaches, including
Linear's claimant-disambiguating comment-marker pattern
(`packages/providers/work-linear/src/provider.ts`) if you need to tell
"already claimed by someone else" from "already claimed by me, retry-safe").

**Contract test**: `describeWorkProviderContract`
(`packages/testkit/src/contracts/work-provider.contract.ts`).

**Wiring**: add a `source.type === '<your-type>'` branch to the `work`
loop in `packages/cli/src/daemon.ts`.

## (d) A source-control provider

Implement `SourceControlProvider` (`packages/core/src/scm.ts`): `detect`,
`clone`, `fetch`, `createBranch`, `status`, `diff`, `commit`, `push`, and
optionally `createPullRequest` (hosting platforms only — plain git has no
PR concept). `GitSourceControlProvider`
(`packages/scm-git/src/*.ts`) is the reference for the git-only subset;
`GitHubSourceControlProvider` layers `createPullRequest` on top via the
`gh` CLI. Both reject commit messages and PR bodies containing
AI-attribution trailers at this layer — match that if your provider also
creates commits or PRs.

**Contract test**: `describeSourceControlProviderContract`
(`packages/testkit/src/contracts/scm-provider.contract.ts`).

**Wiring**: construct and pass it as `RunCoordinatorOptions.scm` in
`packages/cli/src/daemon.ts`.

## (e) A workspace provider

Implement `WorkspaceProvider` (`packages/core/src/workspace.ts`): `strategy`
(a `WorkspaceStrategy` name), `create(request)`, `cleanup(workspace, retention, failed)`.
Use `packages/workspaces/src/path-safety.ts`'s `resolveInsideRoot`/`toSafeSlug`
for any path built from caller-controlled input (run ids, branch names,
repository locators) — every shipped provider does, to guard against path
traversal.

**Contract test**: `describeWorkspaceProviderContract`
(`packages/testkit/src/contracts/workspace-provider.contract.ts`).

**Wiring**: `workspaceRegistry.register(new MyWorkspaceProvider(...))` in
`packages/cli/src/daemon.ts`; your `strategy` string becomes usable in a
workflow's `workspace.strategy` field.

## (f) A workflow action

A `WorkflowActionFactory` is `(context: RunActionContext) => readonly WorkflowAction[]`
(`packages/orchestrator/src/ports.ts`), built fresh per run so it can close
over that run's workspace/branch/scm/work-provider:

```ts
import type { WorkflowAction } from '@overture/core'
import type { RunActionContext, WorkflowActionFactory } from '@overture/orchestrator'

export const myActionFactory: WorkflowActionFactory = (context: RunActionContext) => [
  {
    id: 'my.notify',
    async execute(args) {
      const body = typeof args.message === 'string' ? args.message : ''
      // context.events, context.work, context.scm, context.workspace, context.branch
      // are all available here.
      return { notified: true }
    },
  } satisfies WorkflowAction,
]
```

Register it: `actions.register(myActionFactory)` next to
`actions.register(builtinActionFactory)` in `packages/cli/src/daemon.ts` —
later-registered factories win on `id` collision, so you can also override
a built-in action id. The six built-in actions
(`workflow.assert`, `source_control.commit`, `source_control.push`,
`source_control.pull_request`, `work.comment`, `work.transition`) in
`packages/orchestrator/src/actions.ts` are good references.

An extension can also contribute actions via its own `workflowActions`
export (see (h) below) — `ExtensionHost` forwards them to an `actionSink`
callback you supply, which you'd wire to `actions.register(() => extension.workflowActions)`.
No such wiring exists in `daemon.ts` today, so this path currently needs a
custom composition root.

## (g) A tool

Implement `Tool` (`packages/core/src/tools.ts`): a JSON-Schema `descriptor`,
the `requiredPermissions` checked before every call, and `execute`. This is
`read_file` from `packages/tools/src/filesystem.ts`, in full:

```ts
export const readFileTool: Tool = {
  descriptor: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'number', description: '1-based first line to read.' },
        limit: { type: 'number', description: 'Maximum number of lines.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  requiredPermissions: [PermissionCapability.FilesystemRead],
  async execute(input, context) {
    const { path, offset, limit } = (input ?? {}) as ReadInput
    if (!path) return { content: 'error: path is required', isError: true }
    const resolved = containedPath(workspaceRoot(context), path)
    const raw = await readFile(resolved, 'utf8')
    // ...slice lines, truncate at MAX_READ_CHARS, return { content }
  },
}
```

`ToolExecutionContext` gives you `workspace`, `logger`, `signal`, and
`resolveSecret(name)` for side-channel secret use (env injection into a
subprocess) — never place a raw secret into `content` returned to the
model.

**Wiring**: bundle related tools behind a `ToolProvider` (see
`createCodingToolProvider` in `packages/tools/src/index.ts`) and
`toolRegistry.register(myToolProvider)` in `packages/cli/src/daemon.ts`,
alongside `createCodingToolProvider()`.

## (h) An extension

An extension is trusted local code with a manifest, discovered from
directories configured under `extensions.paths`. The full implementation
lives in `packages/extensions/src` — `manifest.ts` (validation),
`directory-provider.ts` (discovery/loading), `host.ts` (wiring into the
running tool registry / action registry / hook registry).

**On-disk layout**: one subdirectory per extension, each containing
`manifest.json` and an `index.js` entry point:

```
my-extension/
  manifest.json
  index.js
```

**`manifest.json`** (validated against `ExtensionManifest`,
`packages/core/src/extensions.ts`, via a strict Zod schema in
`packages/extensions/src/manifest.ts`):

```json
{
  "id": "com.example.security-scan",
  "name": "Security Scan",
  "version": "1.0.0",
  "description": "Runs a static scan before delivery.",
  "provides": {
    "tools": ["security_scan"],
    "workflowActions": [],
    "hooks": ["before_pull_request"]
  },
  "permissions": ["process.execute", "filesystem.read"]
}
```

`id` must be reverse-DNS-shaped (`^[a-z0-9]+(\.[a-z0-9-]+)+$`); `version`
must be semver; every entry in `provides.hooks` must be a real `HookPoint`;
every entry in `permissions` must be a real `PermissionCapability`.

**`index.js`** exports an `activate` function:

```js
export function activate({ manifest, logger }) {
  return {
    tools: [mySecurityScanTool],
    workflowActions: [],
    hooks: [{ point: 'before_pull_request', handler: myBeforePrHook }],
  }
}
```

**Permission enforcement is two-layered, both at load time**
(`directory-provider.ts`'s `applyManifestHonesty`): first, anything
`activate()` returns that wasn't declared in `manifest.provides` is dropped
with a warning (manifest honesty); second, a contributed tool's
`requiredPermissions` must be a subset of the manifest's declared
`permissions`, or that tool is rejected. Once a tool clears those checks,
it runs through the **same** `PolicyEngine`/permission pipeline as every
built-in tool — there's no separate, weaker "extension" permission tier at
execution time.

**Wiring**: `DirectoryExtensionProvider` and `ExtensionHost` are fully
implemented and tested, but **`packages/cli/src/daemon.ts` doesn't
currently construct either from `extensions.paths`** — extensions loaded
this way today require a custom composition root: construct a
`DirectoryExtensionProvider` per configured path, `host.loadAll()`, and
call `host.wire()` against your `toolRegistry`, `hookRegistry`, and an
`actionSink` pointed at your `WorkflowActionRegistry`.

## (i) Skills

A skill is one `.md` file with YAML frontmatter, in a directory listed
under `skills.paths` (`packages/extensions/src/skills.ts`):

```markdown
---
name: conventional-commits
description: House style for commit messages.
scope: project
---

Use the Conventional Commits format: `type(scope): description`. Never
include AI-attribution trailers.
```

`name`, `description`, and `scope` are required; `scope` must be one of
`global`, `user`, `project`, `workflow`, `agent`. When multiple configured
directories define a skill with the same `name`, the directory passed with
higher precedence wins, regardless of the losing file's own `scope`.
`renderSkillsPrompt` turns a selected set into `## name\n\nbody` blocks
suitable for prompt injection; `selectSkills` filters by scope and a
case-insensitive substring query.

**Wiring**: as with extensions, `loadSkillsFromDirectories` exists and is
tested but `skills.paths` isn't yet read by `packages/cli/src/daemon.ts` —
call it yourself and feed the rendered prompt into an agent step's
`systemPrompt`/context.

## (j) Hooks

`HookRegistry` (`packages/core/src/extensions.ts` for the contract,
`DefaultHookRegistry` in `packages/extensions/src/hook-registry.ts` for the
implementation): `register(point, handler, source)` returns an unregister
function; `run(context)` invokes handlers for that `HookPoint` in
registration order and stops at the **first `block`** — later handlers for
that point don't run. Every handler's `amend` (including a blocking
handler's own) is shallow-merged, left to right, into the outcome's `amend`
payload. A handler that throws or exceeds its timeout (10s default) is
logged and treated as a no-op `continue` — a broken hook can never crash a
run.

```ts
hookRegistry.register('before_tool_call', async (context) => {
  if (context.payload.toolName === 'run_command' && looksDangerous(context.payload)) {
    return { action: 'block', reason: 'blocked by policy hook' }
  }
  return { action: 'continue' }
}, 'my-extension')
```

**Sixteen `HookPoint` values are defined** (`before_work_claim`,
`after_work_claim`, `before_workspace_create`, `after_workspace_create`,
`before_agent_start`, `after_agent_turn`, `before_tool_call`,
`after_tool_call`, `before_subagent`, `after_subagent`, `before_commit`,
`after_commit`, `before_pull_request`, `after_pull_request`, `on_failure`,
`on_complete`, `on_cleanup`) but **only three are actually fired anywhere**
in the shipped runtime — all in `packages/runtime/src/agent-loop.ts`:
`before_tool_call` (can block the call), `after_tool_call`, and
`after_agent_turn`. The other thirteen — including every workspace,
commit, pull-request, and run-completion hook — exist only as contract
today; there's no call site in `packages/orchestrator` or
`packages/runtime` yet. If you need one of those, you'll need to add the
call site as well as the handler.

**Wiring**: `NativeAgentRuntimeOptions.hooks` accepts a `HookRegistry`, but
`packages/cli/src/daemon.ts` never constructs one or passes it in — hooks
are inert in the shipped daemon until you do.

## (k) MCP servers

Configured under `mcp.servers` (see [configuration.md](configuration.md)).
The client (`packages/extensions/src/mcp.ts`) uses the official
`@modelcontextprotocol/sdk`, supports `stdio` (spawns `command`/`args`) and
Streamable HTTP (`url` + static `headers`) transports, connects lazily with
retry/backoff, and namespaces every remote tool as
`mcp_<serverName>_<remoteName>`. Every MCP tool declares
`requiredPermissions: [PermissionCapability.NetworkConnect]` and flows
through the identical `PolicyEngine` check as any built-in tool — deny
`network.connect` in `permissions.rules` and MCP tools are unusable
regardless of server config. MCP servers are deliberately **not** treated
as extensions ([adr-0014](adrs/adr-0014.md)): they're untrusted external
tool sources, not trusted local code with a manifest.

Known gap: remote-server OAuth (mentioned as a design intent in
[adr-0014](adrs/adr-0014.md)) isn't implemented — only static `headers` are
supported for `http` transport today.

**Wiring**: as with extensions and skills, `mcp.servers` is parsed and
validated but `packages/cli/src/daemon.ts` doesn't construct an
`McpToolProvider` from it yet. To wire it yourself: build one
`McpToolProvider` per configured server and `toolRegistry.register(...)`
it, same as any other `ToolProvider`.
