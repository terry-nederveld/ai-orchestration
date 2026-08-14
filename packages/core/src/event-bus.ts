/**
 * Default in-process event bus. Synchronous fan-out with handler isolation:
 * a throwing subscriber never disrupts publishers or other subscribers.
 */

import type {
  EventBus,
  EventFilter,
  EventHandler,
  OrchestratorEvent,
  Unsubscribe,
} from './events.js'
import type { Logger } from './ids.js'
import { noopLogger } from './ids.js'

interface Subscription {
  readonly filter: EventFilter
  readonly handler: EventHandler
}

export class InMemoryEventBus implements EventBus {
  private readonly subscriptions = new Set<Subscription>()

  constructor(private readonly logger: Logger = noopLogger) {}

  publish(event: OrchestratorEvent): void {
    for (const subscription of this.subscriptions) {
      if (!matches(subscription.filter, event)) continue
      try {
        subscription.handler(event)
      } catch (error) {
        this.logger.error('event handler failed', {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const subscription: Subscription = { filter, handler }
    this.subscriptions.add(subscription)
    return () => this.subscriptions.delete(subscription)
  }
}

function matches(filter: EventFilter, event: OrchestratorEvent): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false
  if (filter.runId && event.runId !== filter.runId) return false
  return true
}
