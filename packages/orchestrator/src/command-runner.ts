/**
 * Default command runner for workflow command steps: shell execution with
 * combined output capture, timeout, and abort support.
 */

import { spawn } from 'node:child_process'
import type { CommandResult, CommandRunner } from './ports.js'

const MAX_OUTPUT_CHARS = 60_000

export class DefaultCommandRunner implements CommandRunner {
  constructor(private readonly shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash') {}

  run(
    command: string,
    options: {
      readonly cwd: string
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    },
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
      const child = spawn(this.shell, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000

      const finish = (result: CommandResult | Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({
          exitCode: 124,
          output: `${truncated()}\n[command timed out after ${timeoutMs}ms]`,
        })
      }, timeoutMs)

      const onAbort = () => {
        child.kill('SIGKILL')
        finish(new Error('command aborted'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const truncated = () =>
        output.length > MAX_OUTPUT_CHARS
          ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
          : output

      const append = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString()
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.on('error', (error) => finish(error))
      child.on('close', (code) => finish({ exitCode: code ?? 1, output: truncated() }))
    })
  }
}
