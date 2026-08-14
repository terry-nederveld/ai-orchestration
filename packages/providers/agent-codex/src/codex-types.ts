/**
 * JSONL event shapes emitted by `codex exec --json`, captured from a real
 * run of the installed `codex` CLI (v0.147.0). Not published types from
 * OpenAI, so these are kept intentionally loose: unrecognized `item.type` /
 * event `type` values pass through rather than throwing, since the CLI is
 * expected to grow new item kinds over time.
 */

export interface CodexUsage {
  readonly input_tokens: number
  readonly cached_input_tokens: number
  readonly cache_write_input_tokens: number
  readonly output_tokens: number
  readonly reasoning_output_tokens: number
}

export interface CodexAgentMessageItem {
  readonly id: string
  readonly type: 'agent_message'
  readonly text: string
}

export interface CodexCommandExecutionItem {
  readonly id: string
  readonly type: 'command_execution'
  readonly command: string
  readonly aggregated_output: string
  readonly exit_code: number | null
  readonly status: 'in_progress' | 'completed' | 'failed'
}

export interface CodexFileChangeItem {
  readonly id: string
  readonly type: 'file_change'
  readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: string }>
  readonly status: string
}

export interface CodexErrorItem {
  readonly id: string
  readonly type: 'error'
  readonly message: string
}

export interface CodexUnknownItem {
  readonly id: string
  readonly type: string
  readonly [key: string]: unknown
}

export type CodexItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexErrorItem
  | CodexUnknownItem

export type CodexEvent =
  | { readonly type: 'thread.started'; readonly thread_id: string }
  | { readonly type: 'turn.started' }
  | { readonly type: 'turn.completed'; readonly usage: CodexUsage }
  | { readonly type: 'turn.failed'; readonly error: { readonly message: string } }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'item.started'; readonly item: CodexItem }
  | { readonly type: 'item.completed'; readonly item: CodexItem }
  | { readonly type: string; readonly [key: string]: unknown }

export function isCodexEvent(value: unknown): value is CodexEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

// Explicit type-predicate guards, rather than bare `item.type === '...'`
// checks: CodexUnknownItem's `[key: string]: unknown` index signature makes
// its `type` field structurally compatible with every specific literal, so
// TS's discriminated-union narrowing can't exclude it on equality alone
// (e.g. `item.type === 'agent_message'` still leaves `item.text` typed
// `unknown`). An explicit predicate sidesteps that by asserting the
// narrowed type directly.
export function isAgentMessageItem(item: CodexItem): item is CodexAgentMessageItem {
  return item.type === 'agent_message'
}

export function isCommandExecutionItem(item: CodexItem): item is CodexCommandExecutionItem {
  return item.type === 'command_execution'
}

export function isFileChangeItem(item: CodexItem): item is CodexFileChangeItem {
  return item.type === 'file_change'
}

export function isErrorItem(item: CodexItem): item is CodexErrorItem {
  return item.type === 'error'
}
