import { describe, expect, it } from 'vitest'
import { workflowJsonSchema } from './schema.js'

describe('workflowJsonSchema', () => {
  it('is a JSON Schema object describing the workflow document shape', () => {
    expect(workflowJsonSchema).toMatchObject({ type: 'object' })
    const properties = (workflowJsonSchema as { properties?: Record<string, unknown> }).properties
    expect(properties).toBeDefined()
    expect(properties).toHaveProperty('name')
    expect(properties).toHaveProperty('steps')
    expect(properties).toHaveProperty('transitions')
  })

  it('is serializable (no functions, symbols, or circular references)', () => {
    expect(() => JSON.stringify(workflowJsonSchema)).not.toThrow()
  })
})
