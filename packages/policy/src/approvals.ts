/**
 * Approval gateways resolving `ask` policy decisions.
 */

import type { ApprovalGateway, PermissionRequest, PolicyDecision } from '@overture/core'

/** Headless default: `ask` becomes deny, recorded for observability. */
export class DenyAllApprovalGateway implements ApprovalGateway {
  readonly denied: PermissionRequest[] = []

  async requestApproval(request: PermissionRequest, _decision: PolicyDecision): Promise<boolean> {
    this.denied.push(request)
    return false
  }
}

/**
 * Delegates approval to an async callback (UI prompt, CLI prompt, control
 * plane), with a timeout that fails closed.
 */
export class CallbackApprovalGateway implements ApprovalGateway {
  constructor(
    private readonly callback: (
      request: PermissionRequest,
      decision: PolicyDecision,
    ) => Promise<boolean>,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async requestApproval(request: PermissionRequest, decision: PolicyDecision): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) => {
      const handle = setTimeout(() => resolve(false), this.timeoutMs)
      if (typeof handle === 'object' && 'unref' in handle) handle.unref()
    })
    return Promise.race([this.callback(request, decision), timeout])
  }
}
