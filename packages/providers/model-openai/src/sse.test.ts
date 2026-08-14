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
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: [DONE]\n\n'

  it('parses a whole SSE stream delivered as one chunk', async () => {
    const events = await collect([fullText])
    expect(events).toEqual([
      { data: '{"choices":[{"delta":{"content":"Hel"}}]}' },
      { data: '{"choices":[{"delta":{"content":"lo"}}]}' },
      { data: '[DONE]' },
    ])
  })

  it('parses correctly when split at every character (worst-case chunking)', async () => {
    const events = await collect(fullText.split(''))
    expect(events).toHaveLength(3)
    expect(events[2]).toEqual({ data: '[DONE]' })
  })

  it('parses correctly when a data line is split mid-line across chunks', async () => {
    const idx = fullText.indexOf('"content":"lo"')
    const chunks = [fullText.slice(0, idx), fullText.slice(idx)]
    const events = await collect(chunks)
    expect(events).toHaveLength(3)
    expect(JSON.parse(events[1]?.data ?? '{}')).toEqual({ choices: [{ delta: { content: 'lo' } }] })
  })

  it('splits mid "data:" field prefix across chunks', async () => {
    const idx = fullText.indexOf('data: {"choices":[{"delta":{"content":"lo"') + 'da'.length
    const chunks = [fullText.slice(0, idx), fullText.slice(idx)]
    const events = await collect(chunks)
    expect(events[1]).toEqual({ data: '{"choices":[{"delta":{"content":"lo"}}]}' })
  })

  it('emits a trailing event even without a final blank-line terminator', async () => {
    const events = await collect(['data: {"a":1}'])
    expect(events).toEqual([{ data: '{"a":1}' }])
  })

  it('ignores comment lines starting with a colon', async () => {
    const events = await collect([': keep-alive\n\ndata: {}\n\n'])
    expect(events).toEqual([{ data: '{}' }])
  })

  it('produces no events for an empty stream', async () => {
    expect(await collect([])).toEqual([])
  })
})
