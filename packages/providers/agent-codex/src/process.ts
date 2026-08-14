/**
 * Minimal process-spawning surface this package depends on, narrowed from
 * node:child_process so tests can inject a fake without spawning a real
 * process. Always argument-array based — never shell:true — so prompt text
 * (which may contain anything) can never be interpreted as shell syntax.
 */

import { type ChildProcess, spawn } from 'node:child_process'

export interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals): boolean
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface SpawnOptions {
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
}

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess

export const defaultSpawner: Spawner = (command, args, options) =>
  spawn(command, args as string[], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }) as ChildProcess as unknown as SpawnedProcess
