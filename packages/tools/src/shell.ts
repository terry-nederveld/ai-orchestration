/**
 * Command execution tool. Runs shell commands inside the workspace with
 * output capture, timeout, and abort support. Gated by process.execute
 * permission — policy decides whether a given command may run at all.
 */

import { spawn } from 'node:child_process'
import { PermissionCapability, type Tool } from '@overture/core'
import { sandboxedEnv } from './env.js'
import { containedPath, workspaceRoot } from './paths.js'

const MAX_OUTPUT_CHARS = 30_000

interface RunCommandInput {
  command?: string
  cwd?: string
  timeout_seconds?: number
}

export interface RunCommandOptions {
  /** Extra environment variables (e.g. resolved secrets) for the child. */
  readonly env?: Readonly<Record<string, string>>
  readonly shell?: string
}

export function createRunCommandTool(options: RunCommandOptions = {}): Tool {
  return {
    descriptor: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its output and exit code. ' +
        'Use for builds, tests, linters, and inspecting the environment.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Working directory relative to the workspace.' },
          timeout_seconds: { type: 'number', description: 'Default 120, max 600.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    requiredPermissions: [PermissionCapability.ProcessExecute],
    async execute(input, context) {
      const { command, cwd, timeout_seconds } = (input ?? {}) as RunCommandInput
      if (!command) return { content: 'error: command is required', isError: true }
      const root = workspaceRoot(context)
      const workdir = cwd ? containedPath(root, cwd) : root
      const timeoutMs = Math.min(Math.max(timeout_seconds ?? 120, 1), 600) * 1000

      return new Promise((resolvePromise) => {
        const shell = options.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash')
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
        const child = spawn(shell, args, {
          cwd: workdir,
          env: sandboxedEnv(options.env),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let settled = false

        const finish = (content: string, isError: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          context.signal.removeEventListener('abort', onAbort)
          resolvePromise({ content, ...(isError ? { isError: true } : {}) })
        }

        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish(`command timed out after ${timeoutMs / 1000}s\n${capture()}`, true)
        }, timeoutMs)

        const onAbort = () => {
          child.kill('SIGKILL')
          finish('command aborted', true)
        }
        context.signal.addEventListener('abort', onAbort, { once: true })

        const capture = () => {
          const combined = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
            .filter(Boolean)
            .join('\n')
          return combined.length > MAX_OUTPUT_CHARS
            ? `${combined.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
            : combined
        }

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString()
        })
        child.on('error', (error) => finish(`failed to start command: ${error.message}`, true))
        child.on('close', (code) => {
          const body = capture()
          finish(`exit code: ${code ?? 'unknown'}${body ? `\n${body}` : ''}`, code !== 0)
        })
      })
    },
  }
}
