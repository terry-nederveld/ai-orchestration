/** Fake-fetch helpers shared across this package's tests. No real network I/O. */

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function textErrorResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers })
}

export type FetchCall = { readonly url: string; readonly init: RequestInit }

/** A fetchImpl that dispatches to a handler per call, for tests that route by request body rather than a fixed queue. */
export function routedFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch
}

/** A scripted fetchImpl that returns queued responses in order and records every call. */
export function fakeFetch(responses: readonly Response[]): {
  readonly fetchImpl: typeof fetch
  readonly calls: FetchCall[]
} {
  const queue = [...responses]
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const response = queue.shift()
    if (!response) throw new Error('fakeFetch: no more scripted responses')
    return response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/**
 * Parses the JSON GraphQL request body (`{ query, variables }`) off a recorded
 * call. Accepts `undefined` (as `calls[n]` does under noUncheckedIndexedAccess)
 * and fails with a clear message rather than requiring a non-null assertion
 * at every call site.
 */
export function graphqlBody(call: FetchCall | undefined): {
  query: string
  variables: Record<string, unknown>
} {
  if (!call) throw new Error('graphqlBody: no fetch call recorded at this index')
  return JSON.parse(String(call.init.body)) as { query: string; variables: Record<string, unknown> }
}
