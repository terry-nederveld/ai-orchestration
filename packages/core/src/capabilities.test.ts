import { describe, expect, it } from 'vitest'
import { Capability, CapabilitySet } from './capabilities.js'

describe('CapabilitySet', () => {
  it('answers membership queries', () => {
    const set = CapabilitySet.of(Capability.Chat, Capability.ToolUse)
    expect(set.has(Capability.ToolUse)).toBe(true)
    expect(set.has(Capability.Vision)).toBe(false)
  })

  it('computes missing capabilities', () => {
    const set = CapabilitySet.of(Capability.Chat)
    expect(set.hasAll([Capability.Chat])).toBe(true)
    expect(set.missing([Capability.Chat, Capability.Streaming, Capability.ToolUse])).toEqual([
      Capability.Streaming,
      Capability.ToolUse,
    ])
  })

  it('is immutable; with() returns a new set', () => {
    const base = CapabilitySet.of(Capability.Chat)
    const extended = base.with(Capability.Streaming)
    expect(base.has(Capability.Streaming)).toBe(false)
    expect(extended.has(Capability.Streaming)).toBe(true)
  })
})
