/**
 * Safe process execution: always argument-array based (never shell:true or
 * string-concatenated commands) so caller-controlled values (branch names,
 * paths, messages) can never be interpreted as shell syntax.
 */

import { execFile } from 'node:child_process'
import { OrchestratorError } from '@overture/core'

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
}

const MAX_BUFFER_BYTES = 64 * 1024 * 1024

/** Runs `binary` with `args` (an argument array; never shell-interpreted). */
export function execFileSafe(
  binary: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args as string[],
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(toExecError(binary, args, error, stderr))
          return
        }
        resolvePromise({ stdout, stderr })
      },
    )
  })
}

function toExecError(
  binary: string,
  args: readonly string[],
  error: unknown,
  stderr: string,
): OrchestratorError {
  const detail = stderr.trim() || (error instanceof Error ? error.message : String(error))
  const command = [binary, ...args].join(' ')
  return new OrchestratorError(`Command failed: ${command}\n${detail}`, 'internal', {
    cause: error,
  })
}
