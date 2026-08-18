import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { asId, type CheckpointContext, type RunId } from '@overture/core'
import { GitSourceControlProvider, GitWorktreeManager } from '@overture/scm-git'
import { afterEach, describe, expect, it } from 'vitest'
import { GitBranchCheckpointStrategy } from './git-branch-strategy.js'
import { configureIdentity, git, initRepo, makeTempDir, removeDir } from './test-helpers.js'

const RUN_ID: RunId = asId('run-1')
const BRANCH = 'overture/run-1'

interface Fixture {
  readonly strategy: GitBranchCheckpointStrategy
  readonly scm: GitSourceControlProvider
  /** Bare origin every clone pushes to and restores from. */
  readonly origin: string
  /** A working clone on BRANCH, standing in for the run's workspace. */
  readonly workspace: string
  readonly workspacesRoot: string
  readonly clone: (name: string) => Promise<string>
}

describe('GitBranchCheckpointStrategy', () => {
  let dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => removeDir(dir)))
    dirs = []
  })

  async function setup(): Promise<Fixture> {
    const root = await makeTempDir('overture-checkpoint-')
    dirs.push(root)
    const scm = new GitSourceControlProvider()

    const seed = join(root, 'seed')
    await mkdir(seed)
    await initRepo(seed)
    await writeFile(join(seed, 'README.md'), 'hello\n')
    await scm.commit(seed, { message: 'chore: initial commit' })

    const origin = join(root, 'origin.git')
    await git(root, 'clone', '--bare', seed, origin)

    const clone = async (name: string): Promise<string> => {
      const path = join(root, name)
      await scm.clone({ locator: origin }, path)
      await configureIdentity(path)
      return path
    }

    const workspace = await clone('workspace')
    await scm.createBranch(workspace, BRANCH, 'origin/main')

    const workspacesRoot = join(root, 'workspaces')
    const strategy = new GitBranchCheckpointStrategy({
      scm,
      workspaces: {
        reposRoot: join(root, 'repos'),
        workspacesRoot,
        worktrees: new GitWorktreeManager(),
      },
      resolveRepository: async (runId) => (runId === RUN_ID ? { locator: origin } : undefined),
    })

    return { strategy, scm, origin, workspace, workspacesRoot, clone }
  }

  function context(
    workspacePath: string,
    summary = 'Implement the frobnicator',
  ): CheckpointContext {
    return {
      runId: RUN_ID,
      nodeId: 'node-1',
      specRevision: 2,
      workspacePath,
      branch: BRANCH,
      summary,
    }
  }

  it('rejects a context without workspacePath and branch', async () => {
    const { strategy } = await setup()
    await expect(
      strategy.checkpoint({ runId: RUN_ID, nodeId: 'node-1', specRevision: 1, summary: 'x' }),
    ).rejects.toMatchObject({ category: 'invalid-input' })
  })

  it('commits a WIP checkpoint for a dirty tree and pushes it to origin', async () => {
    const { strategy, scm, origin, workspace } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')

    const checkpoint = await strategy.checkpoint(context(workspace))

    expect(checkpoint.strategy).toBe('git-branch')
    expect(checkpoint.coordinates).toMatchObject({
      branch: BRANCH,
      remote: 'origin',
      repository: origin,
    })
    const sha = checkpoint.coordinates.sha as string
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    // The commit landed on the bare origin, i.e. it is durable.
    expect(await git(origin, 'rev-parse', BRANCH)).toBe(sha)
    const message = await git(origin, 'log', '-1', '--format=%B', BRANCH)
    expect(message).toMatch(/^chore\(checkpoint\): Implement the frobnicator$/m)
    expect(message).not.toMatch(/co-authored-by|generated with|🤖/i)

    const status = await scm.status(workspace)
    expect(status.clean).toBe(true)
  })

  it('trims the WIP commit subject summary to 60 characters', async () => {
    const { strategy, origin, workspace } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const longSummary = 'a'.repeat(80)

    await strategy.checkpoint(context(workspace, longSummary))

    const subject = await git(origin, 'log', '-1', '--format=%s', BRANCH)
    expect(subject).toBe(`chore(checkpoint): ${'a'.repeat(60)}`)
  })

  it('records a checkpoint for a clean, fully pushed tree without creating an empty commit', async () => {
    const { strategy, origin, workspace } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const first = await strategy.checkpoint(context(workspace))

    const second = await strategy.checkpoint(context(workspace))

    expect(second.coordinates.sha).toBe(first.coordinates.sha)
    expect(await git(origin, 'rev-list', '--count', BRANCH)).toBe('2') // initial + one WIP
  })

  it('pushes existing unpushed commits from a clean tree without adding a WIP commit', async () => {
    const { strategy, scm, origin, workspace } = await setup()
    await writeFile(join(workspace, 'feature.txt'), 'done\n')
    const { sha } = await scm.commit(workspace, { message: 'feat: add feature' })

    const checkpoint = await strategy.checkpoint(context(workspace))

    expect(checkpoint.coordinates.sha).toBe(sha)
    expect(await git(origin, 'rev-parse', BRANCH)).toBe(sha)
    expect(await git(origin, 'log', '-1', '--format=%s', BRANCH)).toBe('feat: add feature')
  })

  it('restores a fresh worktree at the checkpoint branch tip', async () => {
    const { strategy, workspace, workspacesRoot } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const checkpoint = await strategy.checkpoint(context(workspace))

    const restored = await strategy.restore(checkpoint)

    const workspacePath = restored.workspacePath as string
    expect(workspacePath.startsWith(workspacesRoot)).toBe(true)
    expect(basename(workspacePath)).toBe('run-1-r1')
    expect(restored.branch).toBe(BRANCH)
    expect(restored.sha).toBe(checkpoint.coordinates.sha)
    expect(restored.note).toBeUndefined()
    expect(await readFile(join(workspacePath, 'notes.md'), 'utf8')).toBe('progress\n')
    expect(await git(workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
  })

  it('restores at the remote head with a note when the origin branch advanced', async () => {
    const { strategy, scm, workspace, clone } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const checkpoint = await strategy.checkpoint(context(workspace))

    const other = await clone('other')
    await git(other, 'checkout', BRANCH)
    await writeFile(join(other, 'later.txt'), 'more\n')
    const { sha: advancedSha } = await scm.commit(other, { message: 'feat: keep going' })
    await scm.push(other, BRANCH)

    const restored = await strategy.restore(checkpoint)

    expect(restored.sha).toBe(advancedSha)
    expect(restored.sha).not.toBe(checkpoint.coordinates.sha)
    expect(String(restored.note)).toContain('restored at remote head')
    expect(await readFile(join(restored.workspacePath as string, 'later.txt'), 'utf8')).toBe(
      'more\n',
    )
  })

  it('gives every restore a fresh non-colliding worktree directory', async () => {
    const { strategy, workspace } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const checkpoint = await strategy.checkpoint(context(workspace))

    const first = await strategy.restore(checkpoint)
    const second = await strategy.restore(checkpoint)

    expect(basename(first.workspacePath as string)).toBe('run-1-r1')
    expect(basename(second.workspacePath as string)).toBe('run-1-r2')
    expect(second.sha).toBe(checkpoint.coordinates.sha)
    expect(await readFile(join(second.workspacePath as string, 'notes.md'), 'utf8')).toBe(
      'progress\n',
    )
  })

  it('refuses to restore when the remote branch no longer contains the checkpoint commit', async () => {
    const { strategy, workspace } = await setup()
    await writeFile(join(workspace, 'notes.md'), 'progress\n')
    const checkpoint = await strategy.checkpoint(context(workspace))

    // Rewrite the remote branch so the checkpoint commit is unreachable.
    await git(workspace, 'reset', '--hard', 'HEAD~1')
    await writeFile(join(workspace, 'rewritten.txt'), 'different\n')
    await git(workspace, 'add', '-A')
    await git(workspace, 'commit', '-m', 'feat: rewritten history')
    await git(workspace, 'push', '--force', 'origin', BRANCH)

    await expect(strategy.restore(checkpoint)).rejects.toMatchObject({ category: 'conflict' })
  })
})
