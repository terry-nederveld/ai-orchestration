/**
 * Duration string parsing for the workflow YAML format: `30s`, `10m`, `2h`,
 * `500ms`. Kept separate from schema.ts so it is trivially unit-testable.
 */

import { DURATION_REGEX } from './duration-regex.js'

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

export function isDurationString(value: string): boolean {
  return DURATION_REGEX.test(value)
}

/** Parses a duration string into milliseconds. Throws on malformed input. */
export function parseDurationMs(value: string): number {
  const match = DURATION_REGEX.exec(value)
  if (!match) {
    throw new Error(
      `invalid duration '${value}'; expected a number followed by ms, s, m, or h (e.g. 30s, 10m, 2h)`,
    )
  }
  const [, amount, unit] = match as unknown as [string, string, string]
  const unitMs = UNIT_MS[unit]
  if (unitMs === undefined) {
    throw new Error(`invalid duration unit in '${value}'`)
  }
  return Number(amount) * unitMs
}
