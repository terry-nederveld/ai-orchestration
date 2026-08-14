/** Fake spawned-process helpers shared across this package's tests. No real `codex` process is ever spawned. */

import { EventEmitter } from 'node:events'
import type { SpawnedProcess, Spawner, SpawnOptions } from './process.js'

export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
}

export interface FakeChild {
  readonly killedWith: string[]
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  emitClose(code: number | null): void
  emitError(error: Error): void
}

export interface FakeSpawnerOptions {
  /**
   * When true, `kill()` immediately emits `close` itself, as a real SIGKILL
   * eventually does once the OS reaps the process. Off by default so
   * existing tests keep driving `emitClose` explicitly after asserting on
   * `killedWith`; the AgentProvider contract suite opts in so cancel()
   * alone is enough to reach a terminal state.
   */
  readonly autoCloseOnKill?: boolean
}

/** Builds a Spawner whose single fake child process is driven manually by the returned control handle. */
export function fakeSpawner(options: FakeSpawnerOptions = {}): {
  spawner: Spawner
  calls: SpawnCall[]
  child: FakeChild
} {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter()
  const killedWith: string[] = []
  const calls: SpawnCall[] = []

  const spawnedProcess: SpawnedProcess = Object.assign(proc, {
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    kill: (signal?: NodeJS.Signals) => {
      killedWith.push(signal ?? 'SIGTERM')
      if (options.autoCloseOnKill)
        queueMicrotask(() => proc.emit('close', null, signal ?? 'SIGTERM'))
      return true
    },
  }) as unknown as SpawnedProcess

  const child: FakeChild = {
    killedWith,
    emitStdout: (chunk) => stdout.emit('data', Buffer.from(chunk)),
    emitStderr: (chunk) => stderr.emit('data', Buffer.from(chunk)),
    emitClose: (code) => proc.emit('close', code, null),
    emitError: (error) => proc.emit('error', error),
  }

  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args, options })
    return spawnedProcess
  }

  return { spawner, calls, child }
}

export function jsonl(...events: unknown[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('')
}
