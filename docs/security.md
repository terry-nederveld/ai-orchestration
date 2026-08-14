# Security Model

This page states plainly what Overture enforces, what it trusts, and what
you are accepting when you enable each feature. It reflects the independent
security review recorded in [adr-0016](adrs/adr-0016.md).

## Threat model in one paragraph

Overture runs LLM-driven agents that execute shell commands and edit files
on your machine, steered by work items written by whoever can file an issue
in your tracker, inside repositories that may contain arbitrary code. The
work item text, the repository contents, and every MCP server's output are
untrusted input. The daemon, its configuration, installed extensions, and
the vendor CLIs you have logged into are trusted.

## What is enforced

- **Workspace containment.** Filesystem tools resolve every path against
  the run's workspace root, including symlink resolution; escapes are
  rejected before any I/O. Workspace and branch names derived from
  external identifiers are slugged and containment-checked.
- **Command-injection defenses.** Workflow `command:` steps receive
  interpolated values through environment-variable indirection, never
  spliced into shell text, so shell metacharacters in an issue title are
  inert. All git and `gh` invocations use argument arrays, never shell
  strings.
- **Permission policy.** Every tool call — built-in or MCP — passes the
  rule-based policy engine (allow/deny/ask/sandbox-only) before executing.
  The permissive `workspace-coding` preset applies only when you have not
  configured permissions at all, or when you explicitly set
  `permissions.preset: workspace-coding`; any explicit permissions
  configuration disables it so `defaultEffect: deny` genuinely denies.
- **Environment hygiene.** Commands spawned in workspaces — by the native
  runtime's shell tool, workflow command steps, and the external coding
  agents (Claude Code, Codex, Copilot) alike — receive an allowlisted
  environment (PATH, HOME, XDG, locale, temp) plus values passed
  explicitly, never the daemon's ambient environment, so operator API
  keys and cloud credentials are not inherited by untrusted code. The
  HOME/XDG allowance is what lets vendor CLIs reach their own stored
  login state. If a build needs a variable such as `JAVA_HOME`, pass it
  via the step's `env:`.
- **Secret redaction.** Secret values resolved from the store are tracked
  (including base64/URI/JSON-escaped forms) and scrubbed from console
  logs, the persisted event log, the SSE stream, and session snapshots.
- **Delivery integrity.** Every commit about to be pushed is validated
  against the attribution/watermark policy, regardless of whether it was
  created through the source-control provider or by an agent running
  `git commit` in a shell. Pull-request titles and bodies are validated
  the same way.
- **Control plane.** The HTTP API binds 127.0.0.1 only, requires a
  per-install random bearer token (compared timing-safely, stored 0600),
  and validates route identifiers strictly. The SSE endpoint accepts the
  token as a query parameter because EventSource cannot set headers; the
  daemon does not log request URLs.
- **Claiming.** Work-item claims are atomic in SQLite and survive
  restarts; a crashed run is marked interrupted and released, never
  silently re-run.

## What is trusted — read this before enabling features

- **Extensions are code you run as yourself.** An extension's
  `activate()` executes in the daemon process with full filesystem,
  network, and environment access. The manifest's declared permissions
  constrain what the extension may *contribute* (its tools inherit and
  are capped by them); the manifest is **not a sandbox** for the
  extension's own code. Installing an extension is equivalent to running
  its installer with your account. Only install extensions you trust.
- **MCP servers are untrusted, but their output reaches your model.**
  Tool calls they serve are permission-gated (target
  `mcp:<server>:<tool>`, gate them per server with policy rules), and
  their output is framed as data-not-instructions in agent context — but
  prompt injection through tool output can never be fully eliminated.
  Prefer approval gates on consequential actions in workflows that use
  third-party MCP servers.
- **Prompt injection is mitigated, not solved.** Work-item content is
  framed as external data and agents are instructed not to follow
  embedded instructions, but a sufficiently capable injection may still
  steer an agent within whatever the policy engine allows. Your policy
  rules and budgets are the real boundary: scope `process.execute` and
  `network.connect` as tightly as your workflows permit.
- **Repository code runs with workspace privileges.** `npm test` in a
  malicious repository executes that repository's code — by design. The
  environment allowlist bounds what it can read; it can still consume
  resources and write inside the workspace. Container-based workspace
  isolation is a planned post-v1 strategy behind the existing
  WorkspaceProvider port.

## Platform notes

- **macOS keychain**: secret writes go through `security
  add-generic-password`, which receives the value in process arguments —
  transiently visible to same-user processes via `ps`. Reads do not
  expose values. A native keyring binding is the planned upgrade
  ([adr-0015](adrs/adr-0015.md)).
- **Linux**: `secret-tool` receives values via stdin (not visible in the
  process table). Headless systems without Secret Service fall back to
  the encrypted vault.
- **Windows and fallback**: the AES-256-GCM vault's key file is
  protection equivalent to an unencrypted SSH private key — anyone who
  can read your home directory can read your secrets. Treat it
  accordingly.

## Reporting

Overture is local-first software; there is no telemetry. If you find a
security issue, open an issue in the repository with the `security` label.
