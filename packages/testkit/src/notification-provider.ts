/**
 * FakeNotificationProvider: records every notification for assertions instead
 * of surfacing it anywhere.
 */

import type { Notification, NotificationProvider } from '@overture/core'

export class FakeNotificationProvider implements NotificationProvider {
  readonly id: string
  /** Every notification passed to notify(), in order. */
  readonly notifications: Notification[] = []

  constructor(id = 'fake-notifications') {
    this.id = id
  }

  async notify(notification: Notification): Promise<void> {
    this.notifications.push(notification)
  }
}
