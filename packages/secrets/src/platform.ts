/**
 * Platform resolution: pick the strongest available secret store.
 *
 *   macOS  → Keychain (security CLI)
 *   Linux  → Secret Service via `secret-tool` when installed
 *   else   → encrypted file fallback
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretProvider } from '@overture/core'
import { EncryptedFileSecretProvider } from './encrypted-file.js'
import { MacKeychainSecretProvider } from './keychain-macos.js'
import { LinuxSecretToolProvider } from './secret-tool-linux.js'

const run = promisify(execFile)

export interface PlatformSecretOptions {
  /** Directory for the encrypted-file fallback (and key). */
  readonly fallbackDirectory: string
  readonly service?: string
  readonly platform?: NodeJS.Platform
}

export async function resolveSecretProvider(
  options: PlatformSecretOptions,
): Promise<SecretProvider> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      await run('security', ['help'])
      return new MacKeychainSecretProvider(options.service)
    } catch {
      // fall through to encrypted file
    }
  }
  if (platform === 'linux') {
    try {
      await run('secret-tool', ['--help'])
      return new LinuxSecretToolProvider(options.service)
    } catch {
      // fall through to encrypted file
    }
  }
  return new EncryptedFileSecretProvider(options.fallbackDirectory)
}
