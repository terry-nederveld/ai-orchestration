/**
 * Linux Secret Service store via `secret-tool` (libsecret). Values are piped
 * through stdin, never argv, so they don't appear in the process table.
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretMetadata, SecretProvider } from '@overture/core'

const run = promisify(execFile)

export class LinuxSecretToolProvider implements SecretProvider {
  readonly id = 'linux-secret-service'

  constructor(private readonly service = 'dev.overture.secrets') {}

  async get(name: string): Promise<string | undefined> {
    try {
      const { stdout } = await run('secret-tool', [
        'lookup',
        'service',
        this.service,
        'account',
        name,
      ])
      return stdout
    } catch {
      return undefined
    }
  }

  set(name: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('secret-tool', [
        'store',
        '--label',
        `Overture: ${name}`,
        'service',
        this.service,
        'account',
        name,
      ])
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`secret-tool exited with ${code}`)),
      )
      child.stdin.end(value)
    })
  }

  async delete(name: string): Promise<void> {
    try {
      await run('secret-tool', ['clear', 'service', this.service, 'account', name])
    } catch {
      // Idempotent delete.
    }
  }

  async list(prefix?: string): Promise<readonly SecretMetadata[]> {
    try {
      const { stdout } = await run('secret-tool', ['search', '--all', 'service', this.service], {
        maxBuffer: 4 * 1024 * 1024,
      })
      const names = [...stdout.matchAll(/attribute\.account = (.+)/g)]
        .map((match) => match[1]?.trim())
        .filter((name): name is string => !!name)
      return names.filter((name) => !prefix || name.startsWith(prefix)).map((name) => ({ name }))
    } catch {
      return []
    }
  }
}
