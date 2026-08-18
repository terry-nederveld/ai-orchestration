/**
 * Test-only helpers for spinning up real git repositories in temp
 * directories (mirrors packages/scm-git). Not exported from the package's
 * public entrypoint.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSafe } from '@overture/scm-git'

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Initializes a git repo with local user config and no commits. */
export async function initRepo(dir: string): Promise<void> {
  await execFileSafe('git', ['init', '-b', 'main'], { cwd: dir })
  await configureIdentity(dir)
}

/** Sets a local test identity so commits never depend on the host's config. */
export async function configureIdentity(dir: string): Promise<void> {
  await execFileSafe('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileSafe('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  await execFileSafe('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileSafe('git', args, { cwd: dir })
  return stdout.trim()
}
