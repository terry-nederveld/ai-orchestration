/**
 * Test-only helpers for spinning up real git repositories in temp
 * directories. Not exported from the package's public entrypoint.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSafe } from './exec.js'

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Initializes a git repo with local user config and an initial commit. */
export async function initRepo(dir: string): Promise<void> {
  await execFileSafe('git', ['init', '-b', 'main'], { cwd: dir })
  await execFileSafe('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileSafe('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  await execFileSafe('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
}
