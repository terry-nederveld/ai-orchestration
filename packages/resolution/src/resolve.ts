/**
 * Context composition: run resolvers in deterministic order, concatenate
 * their fragments, and assemble under the request's character budget.
 * A failing resolver is logged and skipped; the rest still contribute.
 */

import type { ContextBundle, ContextRequest, ContextResolver, Logger } from '@overture/core'
import { assembleContext, noopLogger } from '@overture/core'

export async function resolveContext(
  resolvers: readonly ContextResolver[],
  request: ContextRequest,
  options: { readonly logger?: Logger } = {},
): Promise<ContextBundle> {
  const logger = options.logger ?? noopLogger
  const fragments = []
  for (const resolver of resolvers) {
    try {
      fragments.push(...(await resolver.resolve(request)))
    } catch (error) {
      logger.warn('context resolver failed', {
        resolverId: resolver.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return assembleContext(fragments, request.maxTotalChars)
}
