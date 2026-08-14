import type { WorkspaceRetention } from '@overture/core'

/** Whether cleanup() should physically delete the workspace directory. */
export function shouldDelete(retention: WorkspaceRetention, failed: boolean): boolean {
  switch (retention) {
    case 'always':
      return false
    case 'never':
      return true
    case 'on-failure':
      return !failed
  }
}
