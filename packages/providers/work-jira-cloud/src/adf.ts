/**
 * Atlassian Document Format <-> plain text conversion. Jira Cloud stores
 * rich text (description, comment bodies) as ADF node trees; the rest of the
 * orchestrator only ever sees plain text.
 */

import type { AdfDoc, AdfNode } from './jira-types.js'

function inlineToText(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.content) return node.content.map(inlineToText).join('')
  return ''
}

function listItemToText(node: AdfNode): string {
  return (node.content ?? []).map(blockToText).join(' ')
}

function blockToText(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return (node.content ?? []).map(inlineToText).join('')
    case 'codeBlock':
      return (node.content ?? []).map(inlineToText).join('\n')
    case 'bulletList':
      return (node.content ?? []).map((item) => `- ${listItemToText(item)}`).join('\n')
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => `${index + 1}. ${listItemToText(item)}`)
        .join('\n')
    case 'blockquote':
      return (node.content ?? []).map(blockToText).join('\n')
    default:
      if (node.content) return node.content.map(blockToText).join('\n')
      return inlineToText(node)
  }
}

/** Walks an ADF doc, joining block-level text with blank lines like Markdown. */
export function adfToText(doc: AdfDoc | null | undefined): string {
  if (!doc?.content) return ''
  return doc.content
    .map(blockToText)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Wraps plain text into a minimal single-paragraph ADF document. */
export function textToAdf(text: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: text.length > 0 ? [{ type: 'text', text }] : [],
      },
    ],
  }
}
