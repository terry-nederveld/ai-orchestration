import { OrchestratorError } from '@overture/core'
import { describe, expect, it, vi } from 'vitest'
import type { ExecResult } from './exec.js'
import { GitHubSourceControlProvider } from './github-provider.js'

function baseRequest(
  overrides: Partial<Parameters<GitHubSourceControlProvider['createPullRequest']>[0]> = {},
) {
  return {
    repository: { locator: 'owner/repo' },
    title: 'feat: add widget',
    body: 'Implements the widget.',
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    ...overrides,
  }
}

describe('GitHubSourceControlProvider', () => {
  it('invokes gh pr create with the expected argv via the injectable runner', async () => {
    const calls: Array<{ args: readonly string[] }> = []
    const runner = vi.fn(async (args: readonly string[]): Promise<ExecResult> => {
      calls.push({ args })
      return { stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' }
    })

    const provider = new GitHubSourceControlProvider({ runner })
    const result = await provider.createPullRequest(baseRequest())

    expect(calls).toHaveLength(1)
    const args = calls[0]?.args ?? []
    expect(args[0]).toBe('pr')
    expect(args[1]).toBe('create')
    expect(args).toContain('--title')
    expect(args[args.indexOf('--title') + 1]).toBe('feat: add widget')
    expect(args).toContain('--body-file')
    expect(args).toContain('--base')
    expect(args[args.indexOf('--base') + 1]).toBe('main')
    expect(args).toContain('--head')
    expect(args[args.indexOf('--head') + 1]).toBe('feature/widget')
    expect(args).toContain('--repo')
    expect(args[args.indexOf('--repo') + 1]).toBe('owner/repo')

    expect(result.url).toBe('https://github.com/owner/repo/pull/42')
    expect(result.number).toBe(42)
  })

  it('writes the PR body to a temp file rather than passing it as an argv value', async () => {
    const runner = vi.fn(async (args: readonly string[]): Promise<ExecResult> => {
      const bodyFileIndex = args.indexOf('--body-file')
      expect(bodyFileIndex).toBeGreaterThanOrEqual(0)
      const bodyFile = args[bodyFileIndex + 1]
      expect(bodyFile).toBeDefined()
      expect(args).not.toContain('Implements the widget.')
      return { stdout: 'https://github.com/owner/repo/pull/7\n', stderr: '' }
    })

    const provider = new GitHubSourceControlProvider({ runner })
    await provider.createPullRequest(baseRequest())
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('adds --draft when requested', async () => {
    const runner = vi.fn(
      async (): Promise<ExecResult> => ({
        stdout: 'https://github.com/owner/repo/pull/1\n',
        stderr: '',
      }),
    )
    const provider = new GitHubSourceControlProvider({ runner })
    await provider.createPullRequest(baseRequest({ draft: true }))
    const args = runner.mock.calls[0]?.[0] as readonly string[]
    expect(args).toContain('--draft')
  })

  it('refuses PR bodies with attribution trailers', async () => {
    const runner = vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }))
    const provider = new GitHubSourceControlProvider({ runner })

    await expect(
      provider.createPullRequest(
        baseRequest({ body: 'Implements the widget.\n\nCo-authored-by: Bot <bot@example.com>' }),
      ),
    ).rejects.toMatchObject({ category: 'policy' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses PR bodies with Claude-style watermarks', async () => {
    const runner = vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }))
    const provider = new GitHubSourceControlProvider({ runner })

    let error: unknown
    try {
      await provider.createPullRequest(
        baseRequest({ body: 'Implements the widget.\n\n🤖 Generated with [Claude Code]' }),
      )
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(OrchestratorError)
    expect((error as OrchestratorError).category).toBe('policy')
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses PR titles with attribution content', async () => {
    const runner = vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }))
    const provider = new GitHubSourceControlProvider({ runner })

    await expect(
      provider.createPullRequest(baseRequest({ title: 'Co-authored-by: Bot <bot@example.com>' })),
    ).rejects.toMatchObject({ category: 'policy' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('detect() checks gh auth status through the injectable runner', async () => {
    const runner = vi.fn(async (args: readonly string[]): Promise<ExecResult> => {
      expect(args).toEqual(['auth', 'status'])
      return { stdout: 'Logged in', stderr: '' }
    })
    const provider = new GitHubSourceControlProvider({ runner })
    const availability = await provider.detect()
    expect(availability.available).toBe(true)
    expect(availability.authenticationKind).toBe('cli-session')
  })

  it('detect() reports unavailable when gh auth status fails', async () => {
    const runner = vi.fn(async (): Promise<ExecResult> => {
      throw new Error('not logged in')
    })
    const provider = new GitHubSourceControlProvider({ runner })
    const availability = await provider.detect()
    expect(availability.available).toBe(false)
    expect(availability.authenticated).toBe(false)
  })
})
