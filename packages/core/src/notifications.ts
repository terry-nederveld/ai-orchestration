/**
 * Notification contract: user-facing alerts (approval needed, run finished,
 * budget warnings). Implementations: OS notifications, UI toasts, none.
 */

export type NotificationLevel = 'info' | 'warning' | 'error' | 'action-required'

export interface Notification {
  readonly level: NotificationLevel
  readonly title: string
  readonly body?: string
  /** Deep link into the UI (e.g. a run detail view). */
  readonly link?: string
}

export interface NotificationProvider {
  readonly id: string
  notify(notification: Notification): Promise<void>
}
