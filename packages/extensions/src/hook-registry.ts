/**
 * Default in-memory `HookRegistry`. Handlers run in registration order for a
 * given hook point; the first `block` wins and short-circuits the run.
 * `amend` payloads from every handler that ran (including the blocking one)
 * are shallow-merged into the returned outcome. A handler that throws or
 * exceeds its timeout is logged and treated as `continue` — hooks must never
 * take down a run.
 */

import type {
  HookContext,
  HookHandler,
  HookOutcome,
  HookPoint,
  HookRegistry,
  Logger,
} from '@overture/core'

const DEFAULT_TIMEOUT_MS = 10_000

interface RegisteredHook {
  readonly point: HookPoint
  readonly handler: HookHandler
  readonly source: string
}

export interface DefaultHookRegistryOptions {
  readonly logger: Logger
  /** Per-handler timeout before the handler is skipped. Default: 10s. */
  readonly timeoutMs?: number
}

export class DefaultHookRegistry implements HookRegistry {
  private readonly hooks: RegisteredHook[] = []
  private readonly logger: Logger
  private readonly timeoutMs: number

  constructor(options: DefaultHookRegistryOptions) {
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  register(point: HookPoint, handler: HookHandler, source: string): () => void {
    const entry: RegisteredHook = { point, handler, source }
    this.hooks.push(entry)
    return () => {
      const index = this.hooks.indexOf(entry)
      if (index !== -1) this.hooks.splice(index, 1)
    }
  }

  async run(context: HookContext): Promise<HookOutcome> {
    let amend: Record<string, unknown> | undefined

    for (const hook of this.hooks) {
      if (hook.point !== context.point) continue

      const outcome = await this.runOne(hook, context)
      if (outcome === undefined) continue // threw or timed out; treated as continue

      if (outcome.amend !== undefined) {
        amend = { ...(amend ?? {}), ...outcome.amend }
      }

      if (outcome.action === 'block') {
        return {
          action: 'block',
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          ...(amend !== undefined ? { amend } : {}),
        }
      }
    }

    return { action: 'continue', ...(amend !== undefined ? { amend } : {}) }
  }

  private async runOne(
    hook: RegisteredHook,
    context: HookContext,
  ): Promise<HookOutcome | undefined> {
    try {
      const result = await withTimeout(hook.handler(context), this.timeoutMs)
      if (result === TIMED_OUT) {
        this.logger.warn('hook timed out; skipping', {
          point: hook.point,
          source: hook.source,
          timeoutMs: this.timeoutMs,
        })
        return undefined
      }
      return result
    } catch (error) {
      this.logger.error('hook threw; treating as continue', {
        point: hook.point,
        source: hook.source,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

const TIMED_OUT = Symbol('hook-timeout')

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
