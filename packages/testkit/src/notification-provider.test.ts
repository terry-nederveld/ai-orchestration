import { describe, expect, it } from 'vitest'
import { describeNotificationProviderContract } from './contracts/notification-provider.contract.js'
import { FakeNotificationProvider } from './notification-provider.js'

describeNotificationProviderContract(
  'FakeNotificationProvider',
  () => new FakeNotificationProvider(),
)

describe('FakeNotificationProvider', () => {
  it('records notifications in order', async () => {
    const provider = new FakeNotificationProvider()
    await provider.notify({ level: 'info', title: 'first' })
    await provider.notify({ level: 'error', title: 'second', body: 'detail' })
    expect(provider.notifications).toEqual([
      { level: 'info', title: 'first' },
      { level: 'error', title: 'second', body: 'detail' },
    ])
  })
})
