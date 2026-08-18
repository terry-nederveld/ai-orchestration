import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { GraphEditor } from './GraphEditor'
import type { WorkflowGraphDoc } from './types'

const miniGraph: WorkflowGraphDoc = {
  name: 'mini',
  entry: 'start',
  nodes: [
    { id: 'start', config: { kind: 'action', action: 'workflow.noop' } },
    { id: 'done', config: { kind: 'terminal', outcome: 'completed' } },
  ],
  transitions: [{ id: 's-d', from: 'start', to: 'done' }],
}

function renderEditor(overrides?: {
  onValidate?: ReturnType<typeof vi.fn>
  onSave?: ReturnType<typeof vi.fn>
}) {
  const onValidate = overrides?.onValidate ?? vi.fn().mockResolvedValue([])
  const onSave = overrides?.onSave ?? vi.fn().mockResolvedValue({ version: 2 })
  render(
    <GraphEditor name="mini" initialDocument={miniGraph} onValidate={onValidate} onSave={onSave} />,
  )
  return { onValidate, onSave }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GraphEditor', () => {
  it('re-renders the canvas from an edited YAML document (round trip)', () => {
    vi.useFakeTimers()
    renderEditor()

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }))
    const editedDoc: WorkflowGraphDoc = {
      ...miniGraph,
      nodes: [
        ...miniGraph.nodes,
        { id: 'extra', config: { kind: 'action', action: 'work.comment' } },
      ],
      transitions: [...miniGraph.transitions, { id: 's-e', from: 'start', to: 'extra' }],
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'workflow YAML' }), {
      target: { value: YAML.stringify(editedDoc) },
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }))
    expect(screen.getByRole('button', { name: 'node extra' })).toBeInTheDocument()
  })

  it('shows a parse error inline and keeps the last good document', () => {
    vi.useFakeTimers()
    renderEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'workflow YAML' }), {
      target: { value: 'nodes: [unclosed' },
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText(/YAML:/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }))
    expect(screen.getByRole('button', { name: 'node start' })).toBeInTheDocument()
  })

  it('blocks save when validation reports issues', async () => {
    const onValidate = vi
      .fn()
      .mockResolvedValue([{ path: 'nodes', message: 'no reachable terminal node' }])
    const { onSave } = renderEditor({ onValidate })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/no reachable terminal node/)).toBeInTheDocument()
    expect(onValidate).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves when validation passes and reports the minted version', async () => {
    const { onSave } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Saved as version 2/)).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledWith(miniGraph)
  })

  it('projects inspector edits into the YAML view (one canonical document)', async () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'node start' }))
    const configArea = screen.getByRole('textbox', { name: 'node config JSON' })
    fireEvent.change(configArea, {
      target: { value: JSON.stringify({ kind: 'action', action: 'work.comment' }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }))

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }))
    const yamlArea = screen.getByRole('textbox', { name: 'workflow YAML' }) as HTMLTextAreaElement
    expect(yamlArea.value).toContain('work.comment')
  })
})
