/** Helpers for `<source>:<externalId>` work item references. */

export interface WorkRef {
  readonly source?: string
  readonly externalId: string
}

export function splitWorkRef(workItemId: string): WorkRef {
  const separator = workItemId.indexOf(':')
  if (separator === -1) return { externalId: workItemId }
  return { source: workItemId.slice(0, separator), externalId: workItemId.slice(separator + 1) }
}
