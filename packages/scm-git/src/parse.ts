/**
 * Parsers for `git status --porcelain=v2 --branch` and `git diff --numstat`
 * output. Kept isolated from process execution so they're trivially unit
 * testable against fixed strings.
 */

import type { RepoStatus } from '@overture/core'

export function parsePorcelainV2Status(output: string): RepoStatus {
  let branch = ''
  let ahead = 0
  let behind = 0
  const changedFiles: string[] = []

  for (const line of output.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      if (match?.[1] !== undefined && match[2] !== undefined) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (line.startsWith('#')) continue

    const kind = line[0]
    const parts = line.split(' ')
    if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path\torigPath
      const fixedFieldCount = kind === '1' ? 8 : 9
      const rest = parts.slice(fixedFieldCount).join(' ')
      const path = rest.split('\t')[0]
      if (path) changedFiles.push(path)
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const path = parts.slice(10).join(' ')
      if (path) changedFiles.push(path)
    } else if (kind === '?') {
      const path = parts.slice(1).join(' ')
      if (path) changedFiles.push(path)
    }
    // '!' (ignored) entries are intentionally excluded from changedFiles.
  }

  return { branch, clean: changedFiles.length === 0, ahead, behind, changedFiles }
}

export interface NumstatSummary {
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
}

export function parseNumstat(output: string): NumstatSummary {
  const lines = output.split('\n').filter((line) => line.length > 0)
  let insertions = 0
  let deletions = 0
  for (const line of lines) {
    const [ins, del] = line.split('\t')
    if (ins !== undefined && ins !== '-') insertions += Number(ins)
    if (del !== undefined && del !== '-') deletions += Number(del)
  }
  return { filesChanged: lines.length, insertions, deletions }
}

const MAX_PATCH_BYTES = 1024 * 1024

/** Caps a unified diff patch at 1MB, appending a truncation marker if cut. */
export function capPatch(patch: string): string {
  const buffer = Buffer.from(patch, 'utf8')
  if (buffer.byteLength <= MAX_PATCH_BYTES) return patch
  return `${buffer.subarray(0, MAX_PATCH_BYTES).toString('utf8')}\n... [patch truncated at 1MB]`
}

export interface WorktreeInfo {
  readonly path: string
  readonly head: string
  readonly bare: boolean
  readonly detached: boolean
  readonly branch?: string
}

/** Parses `git worktree list --porcelain` output into structured records. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const blocks = output
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
  return blocks.map((block) => {
    let path = ''
    let head = ''
    let branch: string | undefined
    let bare = false
    let detached = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') bare = true
      else if (line === 'detached') detached = true
    }
    return { path, head, bare, detached, ...(branch !== undefined ? { branch } : {}) }
  })
}
