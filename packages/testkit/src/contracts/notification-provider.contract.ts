/**
 * Behavioral contract every NotificationProvider implementation must
 * satisfy: notify() accepts every notification level without throwing.
 */

import type { NotificationLevel, NotificationProvider } from '@overture/core'
import { describe, expect, it } from 'vitest'

const LEVELS: readonly NotificationLevel[] = ['info', 'warning', 'error', 'action-required']

export function describeNotificationProviderContract(
  name: string,
  factory: () => NotificationProvider | Promise<NotificationProvider>,
): void {
  describe(`NotificationProvider contract: ${name}`, () => {
    it('exposes a stable id', async () => {
      const provider = await factory()
      expect(provider.id).toBeTruthy()
    })

    it.each(LEVELS)('notify() accepts level "%s" without throwing', async (level) => {
      const provider = await factory()
      await provider.notify({ level, title: `contract test: ${level}` })
    })
  })
}
