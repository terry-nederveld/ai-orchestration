import { describe, expect, it } from 'vitest'
import { parseSse } from './sse.js'

function streamFromChunks(chunks: readonly string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk)
  })()
}

async function collect(chunks: readonly string[]) {
  const events = []
  for await (const event of parseSse(streamFromChunks(chunks))) events.push(event)
  return events
}

describe('parseSse', () => {
  const fullText =
    'event: message_start\ndata: {"type":"message_start"}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'

  it('parses a whole SSE stream delivered as one chunk', async () => {
    const events = await collect([fullText])
    expect(events).toEqual([
      { event: 'message_start', data: '{"type":"message_start"}' },
      {
        event: 'content_block_delta',
        data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      },
      { event: 'message_stop', data: '{"type":"message_stop"}' },
    ])
  })

  it('parses correctly when split at every character (worst-case chunking)', async () => {
    const chunks = fullText.split('')
    const events = await collect(chunks)
    expect(events).toHaveLength(3)
    expect(events[1]).toEqual({
      event: 'content_block_delta',
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    })
  })

  it('parses correctly when a data line is split mid-line across chunks', async () => {
    // Split right in the middle of the JSON payload of the second event.
    const idx = fullText.indexOf('"text_delta"')
    const chunks = [fullText.slice(0, idx), fullText.slice(idx)]
    const events = await collect(chunks)
    expect(events).toHaveLength(3)
    expect(JSON.parse(events[1]?.data ?? '{}')).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    })
  })

  it('splits mid-field-name across chunks', async () => {
    const idx = fullText.indexOf('event: content_block_delta') + 'event: cont'.length
    const chunks = [fullText.slice(0, idx), fullText.slice(idx)]
    const events = await collect(chunks)
    expect(events[1]?.event).toBe('content_block_delta')
  })

  it('joins multi-line data fields with newlines', async () => {
    const text = 'event: foo\ndata: line one\ndata: line two\n\n'
    const events = await collect([text])
    expect(events).toEqual([{ event: 'foo', data: 'line one\nline two' }])
  })

  it('ignores comment lines starting with a colon', async () => {
    const text = ': keep-alive\n\nevent: foo\ndata: {}\n\n'
    const events = await collect([text])
    expect(events).toEqual([{ event: 'foo', data: '{}' }])
  })

  it('emits a trailing event even without a final blank-line terminator', async () => {
    const text = 'event: foo\ndata: {"a":1}'
    const events = await collect([text])
    expect(events).toEqual([{ event: 'foo', data: '{"a":1}' }])
  })

  it('handles data-only events without an event field', async () => {
    const text = 'data: {"type":"ping"}\n\n'
    const events = await collect([text])
    expect(events).toEqual([{ data: '{"type":"ping"}' }])
  })

  it('produces no events for an empty stream', async () => {
    const events = await collect([])
    expect(events).toEqual([])
  })
})
