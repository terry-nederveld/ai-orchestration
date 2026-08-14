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

/** Builds a streamed Response whose body is delivered as the given chunks, in order. */
export function sseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** Formats a single OpenAI SSE chunk (data: json\n\n). */
export function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function sseDone(): string {
  return 'data: [DONE]\n\n'
}

export type FetchCall = { readonly url: string; readonly init: RequestInit }

/** A scripted fetchImpl that returns queued responses in order and records every call. */
export function fakeFetch(responses: readonly Response[]): {
  readonly fetchImpl: typeof fetch
  readonly calls: FetchCall[]
} {
  const queue = [...responses]
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException('Aborted', 'AbortError')
    }
    const response = queue.shift()
    if (!response) throw new Error('fakeFetch: no more scripted responses')
    return response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** A fetchImpl that dispatches to a handler per call, for tests that need routing by URL/body rather than a fixed queue. */
export function routedFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException('Aborted', 'AbortError')
    }
    return handler(String(input), init ?? {})
  }) as typeof fetch
}
