/** Fake spawned-process helpers shared across this package's tests. No real `copilot` process is ever spawned. */

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

export function fakeSpawner(): { spawner: Spawner; calls: SpawnCall[]; child: FakeChild } {
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
