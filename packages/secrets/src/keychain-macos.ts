/**
 * macOS Keychain secret store via the `security` CLI (generic passwords under
 * a single service name). Values are passed via argv to `security`, which is
 * process-local; they are never written to disk or logged.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretMetadata, SecretProvider } from '@overture/core'

const run = promisify(execFile)

export class MacKeychainSecretProvider implements SecretProvider {
  readonly id = 'macos-keychain'

  constructor(private readonly service = 'dev.overture.secrets') {}

  async get(name: string): Promise<string | undefined> {
    try {
      const { stdout } = await run('security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        name,
        '-w',
      ])
      return stdout.replace(/\n$/, '')
    } catch {
      return undefined
    }
  }

  async set(name: string, value: string): Promise<void> {
    await run('security', [
      'add-generic-password',
      '-U',
      '-s',
      this.service,
      '-a',
      name,
      '-w',
      value,
    ])
  }

  async delete(name: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-s', this.service, '-a', name])
    } catch {
      // Missing entries are fine; delete is idempotent.
    }
  }

  async list(prefix?: string): Promise<readonly SecretMetadata[]> {
    // `security` has no efficient per-service account listing; dump-keychain
    // output is parsed for our service's account names only (names are not
    // secret values).
    try {
      const { stdout } = await run('security', ['dump-keychain'], { maxBuffer: 16 * 1024 * 1024 })
      const names = new Set<string>()
      const blocks = stdout.split('keychain: ')
      for (const block of blocks) {
        if (!block.includes(`"${this.service}"`)) continue
        const match = block.match(/"acct"<blob>="([^"]+)"/)
        if (match?.[1]) names.add(match[1])
      }
      return [...names]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name }))
    } catch {
      return []
    }
  }
}
