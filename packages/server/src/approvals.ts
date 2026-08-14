/**
 * Approval broker: turns `ask` policy decisions and workflow approval steps
 * into pending requests resolvable through the control-plane API (UI or CLI).
 * Unresolved requests fail closed after a timeout.
 */

import type {
  ApprovalGateway,
  Clock,
  IdGenerator,
  PermissionRequest,
  PolicyDecision,
} from '@overture/core'
import { systemClock } from '@overture/core'

export interface PendingApproval {
  readonly id: string
  readonly request: PermissionRequest
  readonly decision: PolicyDecision
  readonly requestedAt: Date
}

interface PendingEntry extends PendingApproval {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalBroker implements ApprovalGateway {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock = systemClock,
    private readonly timeoutMs = 30 * 60 * 1000,
    private readonly onChange?: (pending: readonly PendingApproval[]) => void,
  ) {}

  list(): readonly PendingApproval[] {
    return [...this.pending.values()].map(({ id, request, decision, requestedAt }) => ({
      id,
      request,
      decision,
      requestedAt,
    }))
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(approved)
    this.onChange?.(this.list())
    return true
  }

  requestApproval(request: PermissionRequest, decision: PolicyDecision): Promise<boolean> {
    const id = this.ids.next('approval')
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.onChange?.(this.list())
        resolvePromise(false)
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        id,
        request,
        decision,
        requestedAt: this.clock.now(),
        resolve: resolvePromise,
        timer,
      })
      this.onChange?.(this.list())
    })
  }
}
