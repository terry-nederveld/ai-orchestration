/**
 * Local coding-agent binary discovery. Probes PATH for the CLIs the agent
 * providers in this workspace can drive (claude, codex, copilot) plus
 * adjacent tooling they depend on (gh, ollama), without assuming any of
 * them are installed.
 */

import { execFile } from 'node:child_process'

export type LocalAgentId = 'claude' | 'codex' | 'copilot' | 'gh' | 'ollama'

export interface DiscoveredAgent {
  readonly id: LocalAgentId
  readonly binary: string
  readonly installed: boolean
  readonly version?: string
}

/** Runs `binary --version` (or an id-specific override) and returns trimmed stdout. Injectable for tests. */
export type VersionRunner = (binary: string, args: readonly string[]) => Promise<string>

const DEFAULT_PROBES: ReadonlyArray<{
  readonly id: LocalAgentId
  readonly binary: string
  readonly args: readonly string[]
}> = [
  { id: 'claude', binary: 'claude', args: ['--version'] },
  { id: 'codex', binary: 'codex', args: ['--version'] },
  { id: 'copilot', binary: 'copilot', args: ['--version'] },
  { id: 'gh', binary: 'gh', args: ['--version'] },
  { id: 'ollama', binary: 'ollama', args: ['--version'] },
]

export const defaultVersionRunner: VersionRunner = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(binary, args as string[], { shell: false }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })

/**
 * Probes for each known local agent binary. Never throws: a missing or
 * failing binary is reported as `installed: false` rather than rejecting.
 */
export async function discoverLocalAgents(
  runner: VersionRunner = defaultVersionRunner,
): Promise<DiscoveredAgent[]> {
  return Promise.all(
    DEFAULT_PROBES.map(async (probe) => {
      try {
        const version = await runner(probe.binary, probe.args)
        return { id: probe.id, binary: probe.binary, installed: true, version }
      } catch {
        return { id: probe.id, binary: probe.binary, installed: false }
      }
    }),
  )
}
