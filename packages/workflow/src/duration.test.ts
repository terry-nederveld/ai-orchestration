import { describe, expect, it } from 'vitest'
import { isDurationString, parseDurationMs } from './duration.js'

describe('parseDurationMs', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['10m', 600_000],
    ['2h', 7_200_000],
    ['0s', 0],
  ])('parses %s as %i ms', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected)
  })

  it.each(['30', '30sec', '-5s', '5 s', '', 'ten minutes'])('rejects %j', (input) => {
    expect(() => parseDurationMs(input)).toThrow(/invalid duration/)
  })
})

describe('isDurationString', () => {
  it('accepts well-formed durations', () => {
    expect(isDurationString('30s')).toBe(true)
  })

  it('rejects malformed durations', () => {
    expect(isDurationString('30sec')).toBe(false)
  })
})
