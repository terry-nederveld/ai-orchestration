import { describe, expect, it } from 'vitest'
import { describeSourceControlProviderContract } from './contracts/scm-provider.contract.js'
import { FakeSourceControlProvider } from './scm-provider.js'

let workdirSeq = 0
const nextWorkdir = () => `/fake/workdir-${++workdirSeq}`

describeSourceControlProviderContract(
  'FakeSourceControlProvider',
  () => new FakeSourceControlProvider(),
  nextWorkdir,
)

describe('FakeSourceControlProvider', () => {
  it('tracks commit history per workdir', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    await provider.commit(workdir, { message: 'first' })
    await provider.commit(workdir, { message: 'second' })
    expect(provider.commitsFor(workdir).map((c) => c.message)).toEqual(['first', 'second'])
  })

  it('setDirty() makes status() report an unclean workdir with changed files', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    provider.setDirty(workdir, true, ['src/a.ts', 'src/b.ts'])
    const status = await provider.status(workdir)
    expect(status.clean).toBe(false)
    expect(status.changedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('commit() clears the dirty flag set by setDirty()', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    provider.setDirty(workdir, true, ['src/a.ts'])
    await provider.commit(workdir, { message: 'clean it up' })
    const status = await provider.status(workdir)
    expect(status.clean).toBe(true)
    expect(status.changedFiles).toEqual([])
  })

  it('push() resets the ahead counter configured via setAheadBehind()', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    provider.setAheadBehind(workdir, 3, 0)
    expect((await provider.status(workdir)).ahead).toBe(3)
    await provider.push(workdir, 'main')
    expect((await provider.status(workdir)).ahead).toBe(0)
  })

  it('setDiffResult() overrides what diff() returns for a workdir', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    provider.setDiffResult(workdir, {
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
      patch: 'diff --git ...',
    })
    const diff = await provider.diff(workdir)
    expect(diff).toEqual({ filesChanged: 2, insertions: 10, deletions: 1, patch: 'diff --git ...' })
  })

  it('records every operation in the call log', async () => {
    const provider = new FakeSourceControlProvider()
    const workdir = nextWorkdir()
    await provider.clone({ locator: 'org/repo' }, workdir)
    await provider.fetch(workdir)
    await provider.createBranch(workdir, 'feature/x')
    await provider.commit(workdir, { message: 'm' })
    await provider.push(workdir, 'feature/x')
    expect(provider.calls.map((c) => c.op)).toEqual([
      'clone',
      'fetch',
      'createBranch',
      'commit',
      'push',
    ])
  })
})
