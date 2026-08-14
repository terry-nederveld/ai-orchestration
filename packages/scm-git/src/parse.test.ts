import { describe, expect, it } from 'vitest'
import { capPatch, parseNumstat, parsePorcelainV2Status, parseWorktreeList } from './parse.js'

describe('parsePorcelainV2Status', () => {
  it('parses branch, ahead/behind, and a mix of entry kinds', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb tracked.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt\told-name.txt',
      '? untracked.txt',
      '! ignored.txt',
      '',
    ].join('\n')

    const status = parsePorcelainV2Status(output)
    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
    expect(status.clean).toBe(false)
    expect(status.changedFiles).toEqual(['tracked.txt', 'new-name.txt', 'untracked.txt'])
  })

  it('reports clean when there are no entries', () => {
    const output = '# branch.oid abc123\n# branch.head main\n# branch.ab +0 -0\n'
    const status = parsePorcelainV2Status(output)
    expect(status.clean).toBe(true)
    expect(status.changedFiles).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('sums insertions and deletions across files, ignoring binary markers', () => {
    const output = '3\t1\tfile-a.txt\n0\t5\tfile-b.txt\n-\t-\tbinary.png\n'
    const summary = parseNumstat(output)
    expect(summary.filesChanged).toBe(3)
    expect(summary.insertions).toBe(3)
    expect(summary.deletions).toBe(6)
  })

  it('handles empty output', () => {
    expect(parseNumstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

describe('capPatch', () => {
  it('leaves small patches untouched', () => {
    const patch = 'diff --git a/x b/x\n+hello\n'
    expect(capPatch(patch)).toBe(patch)
  })

  it('truncates patches larger than 1MB and marks truncation', () => {
    const huge = 'a'.repeat(1024 * 1024 + 100)
    const capped = capPatch(huge)
    expect(capped.length).toBeLessThan(huge.length)
    expect(capped).toContain('[patch truncated at 1MB]')
  })
})

describe('parseWorktreeList', () => {
  it('parses multiple worktree blocks including bare and detached', () => {
    const output = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-1',
      'HEAD def456',
      'branch refs/heads/run-1',
      '',
      'worktree /repo/wt-detached',
      'HEAD ghi789',
      'detached',
      '',
    ].join('\n')

    const list = parseWorktreeList(output)
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ path: '/repo/main', branch: 'main' })
    expect(list[1]).toMatchObject({ path: '/repo/wt-1', branch: 'run-1' })
    expect(list[2]).toMatchObject({ path: '/repo/wt-detached', detached: true })
    expect(list[2]?.branch).toBeUndefined()
  })
})
