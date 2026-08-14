import { describe, expect, it } from 'vitest'
import { adfToText, textToAdf } from './adf.js'
import type { AdfDoc } from './jira-types.js'

describe('adfToText', () => {
  it('returns an empty string for a null or missing doc', () => {
    expect(adfToText(null)).toBe('')
    expect(adfToText(undefined)).toBe('')
  })

  it('extracts plain text from a single paragraph', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    }
    expect(adfToText(doc)).toBe('Hello world')
  })

  it('joins multiple paragraphs with a blank line', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
      ],
    }
    expect(adfToText(doc)).toBe('First\n\nSecond')
  })

  it('concatenates nested inline marks (bold/italic runs) within a paragraph', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'bold', attrs: { marks: [{ type: 'strong' }] } },
            { type: 'text', text: ' world' },
          ],
        },
      ],
    }
    expect(adfToText(doc)).toBe('Hello bold world')
  })

  it('converts hardBreak nodes to newlines', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Line one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Line two' },
          ],
        },
      ],
    }
    expect(adfToText(doc)).toBe('Line one\nLine two')
  })

  it('renders bulletList items with a leading dash', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First item' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second item' }] }],
            },
          ],
        },
      ],
    }
    expect(adfToText(doc)).toBe('- First item\n- Second item')
  })

  it('renders orderedList items with a numeric prefix', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step two' }] }],
            },
          ],
        },
      ],
    }
    expect(adfToText(doc)).toBe('1. Step one\n2. Step two')
  })

  it('joins codeBlock lines with newlines', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    }
    expect(adfToText(doc)).toBe('const x = 1')
  })

  it('handles a nested tree spanning paragraphs, lists, and a code block', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Repro steps:' }] },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open the app' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click submit' }] }],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'Error: boom' }] },
      ],
    }
    expect(adfToText(doc)).toBe('Repro steps:\n\n1. Open the app\n2. Click submit\n\nError: boom')
  })

  it('skips empty blocks rather than emitting stray blank lines', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Only content' }] },
      ],
    }
    expect(adfToText(doc)).toBe('Only content')
  })
})

describe('textToAdf', () => {
  it('wraps text into a single-paragraph ADF doc', () => {
    expect(textToAdf('hello')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
  })

  it('produces an empty paragraph content array for empty text', () => {
    expect(textToAdf('')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [] }],
    })
  })

  it('round-trips through adfToText', () => {
    expect(adfToText(textToAdf('Round trip me'))).toBe('Round trip me')
  })
})
