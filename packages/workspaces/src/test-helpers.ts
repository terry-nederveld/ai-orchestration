/**
 * Test-only helpers for spinning up real git repositories. Not exported
 * from the package's public entrypoint.
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

export async function initRepo(dir: string): Promise<void> {
  await execFileSafe('git', ['init', '-b', 'main'], { cwd: dir })
  await execFileSafe('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileSafe('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  await execFileSafe('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
}
