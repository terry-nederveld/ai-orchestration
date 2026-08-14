/**
 * Daemon state directory: connection info (port + token) written 0600 so
 * local clients (CLI, desktop shell) can find and authenticate to the
 * daemon. The token file must never be world-readable or logged.
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DaemonInfo {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly pid: number
}

export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state'), 'overture')
}

const infoFile = (stateDir: string) => join(stateDir, 'daemon.json')

export async function writeDaemonInfo(stateDir: string, info: DaemonInfo): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const path = infoFile(stateDir)
  await writeFile(path, JSON.stringify(info, null, 2), { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readDaemonInfo(stateDir: string): Promise<DaemonInfo | undefined> {
  try {
    const raw = await readFile(infoFile(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as DaemonInfo
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export async function clearDaemonInfo(stateDir: string): Promise<void> {
  await rm(infoFile(stateDir), { force: true })
}

/** True when the recorded daemon process is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
