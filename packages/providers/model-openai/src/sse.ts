/**
 * Minimal Server-Sent-Events line parser. Buffers across chunk boundaries so
 * a `data:` line split mid-write (as real HTTP chunking does) still parses
 * correctly, and groups `event:`/`data:` fields into events on blank lines
 * per the SSE spec.
 */

export interface SseEvent {
  readonly event?: string
  readonly data: string
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let sawField = false

  function reset(): void {
    eventName = undefined
    dataLines = []
    sawField = false
  }

  function* handleLine(line: string): Generator<SseEvent> {
    if (line === '') {
      if (sawField)
        yield {
          ...(eventName !== undefined ? { event: eventName } : {}),
          data: dataLines.join('\n'),
        }
      reset()
      return
    }
    if (line.startsWith(':')) return
    const colonIdx = line.indexOf(':')
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx)
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      eventName = value
      sawField = true
    } else if (field === 'data') {
      dataLines.push(value)
      sawField = true
    }
    // ignore id/retry/other fields
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      yield* handleLine(line)
      newlineIndex = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.length > 0) yield* handleLine(buffer)
  if (sawField)
    yield { ...(eventName !== undefined ? { event: eventName } : {}), data: dataLines.join('\n') }
}
