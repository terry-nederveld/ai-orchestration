/**
 * FakeWorkspaceProvider: creates real temporary directories so tools under
 * test can actually read and write files. Cleanup honors the same retention
 * semantics real workspace providers must implement.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asId,
  type ProviderInfo,
  type Workspace,
  type WorkspaceProvider,
  type WorkspaceRequest,
  type WorkspaceRetention,
  type WorkspaceStrategy,
} from '@overture/core'

export type WorkspaceCleanupAction = 'kept' | 'deleted'

export interface WorkspaceCleanupRecord {
  readonly workspace: Workspace
  readonly retention: WorkspaceRetention
  readonly failed: boolean
  readonly action: WorkspaceCleanupAction
}

export interface FakeWorkspaceProviderOptions {
  readonly info?: Partial<ProviderInfo>
}

/** Decides whether cleanup keeps or deletes, per the WorkspaceRetention contract. */
function cleanupAction(retention: WorkspaceRetention, failed: boolean): WorkspaceCleanupAction {
  switch (retention) {
    case 'always':
      return 'kept'
    case 'never':
      return 'deleted'
    case 'on-failure':
      return failed ? 'kept' : 'deleted'
  }
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly info: ProviderInfo
  readonly strategy: WorkspaceStrategy = 'temp-directory'
  /** Every cleanup() call and the action taken, for assertions. */
  readonly cleanups: WorkspaceCleanupRecord[] = []

  private readonly baseDir: string
  private seq = 0

  constructor(baseDir: string = tmpdir(), options: FakeWorkspaceProviderOptions = {}) {
    this.baseDir = baseDir
    this.info = {
      id: 'fake-workspace',
      displayName: 'Fake Workspace Provider',
      kind: 'workspace',
      consumption: 'local',
      authentication: ['none'],
      ...options.info,
    }
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    this.seq += 1
    const path = await mkdtemp(join(this.baseDir, `overture-testkit-${request.runId}-`))
    return {
      id: asId(`ws-${this.seq}`),
      strategy: this.strategy,
      path,
      createdAt: new Date(),
      ...(request.repository !== undefined ? { repository: request.repository } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    }
  }

  async cleanup(
    workspace: Workspace,
    retention: WorkspaceRetention,
    failed: boolean,
  ): Promise<void> {
    const action = cleanupAction(retention, failed)
    if (action === 'deleted' && (await pathExists(workspace.path))) {
      await rm(workspace.path, { recursive: true, force: true })
    }
    this.cleanups.push({ workspace, retention, failed, action })
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
