import { describe, expect, it } from 'vitest'
import { JsonlSplitter } from './jsonl.js'

describe('JsonlSplitter', () => {
  it('parses multiple complete lines in a single chunk', () => {
    const splitter = new JsonlSplitter()
    const lines = splitter.push('{"a":1}\n{"b":2}\n')
    expect(lines).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('buffers a line split across two chunks and emits it once complete', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.push('{"a":1')).toEqual([])
    expect(splitter.push('}\n')).toEqual([{ a: 1 }])
  })

  it('buffers a line split across three chunks', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.push('{"th')).toEqual([])
    expect(splitter.push('read_id":"abc"')).toEqual([])
    expect(splitter.push('}\n')).toEqual([{ thread_id: 'abc' }])
  })

  it('drops malformed lines without throwing', () => {
    const splitter = new JsonlSplitter()
    const lines = splitter.push('not json\n{"ok":true}\n')
    expect(lines).toEqual([{ ok: true }])
  })

  it('ignores blank lines', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }])
  })

  it('flush() emits a final line with no trailing newline', () => {
    const splitter = new JsonlSplitter()
    splitter.push('{"a":1}\n{"b":2}')
    expect(splitter.flush()).toEqual([{ b: 2 }])
  })

  it('flush() emits nothing when the buffer is empty', () => {
    const splitter = new JsonlSplitter()
    splitter.push('{"a":1}\n')
    expect(splitter.flush()).toEqual([])
  })
})
