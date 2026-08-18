import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EvaluatePanel } from './EvaluatePanel'
import type { EvaluationReportView } from './types'

const report: EvaluationReportView = {
  workflow: { name: 'autonomous-delivery', version: 3, lifecycle: 'enabled', validationIssues: [] },
  matching: {
    selection: 'explicit',
    rationale: "workflow 'autonomous-delivery'@3 explicitly selected for work item 'ISSUE-9'",
  },
  repositories: {
    resolved: [
      { repository: { locator: 'acme/api' }, role: 'primary', resolvedBy: 'item-metadata' },
    ],
    rulesEvaluated: [],
  },
  instructions: [
    {
      providerId: 'conventions',
      source: 'CLAUDE.md',
      scope: 'repository',
      path: 'CLAUDE.md',
      precedence: 10,
    },
  ],
  contextPreview: { fragments: [], excluded: [], totalChars: 0 },
  gates: [
    {
      nodeId: 'dor',
      gateSetName: 'delivery-definition-of-ready',
      gateSetVersion: 1,
      gates: [
        {
          gateId: 'has-description',
          kind: 'deterministic',
          required: true,
          outcome: 'pass',
          reason: 'expression true',
        },
        {
          gateId: 'acceptance-inferable',
          kind: 'agent',
          required: true,
          outcome: 'indeterminate',
          reason: 'agent-evaluated gate; not run in evaluation',
        },
      ],
    },
  ],
  path: { nodes: ['dor', 'plan', 'implement'], stopReason: 'indeterminate:implement' },
  profiles: [
    {
      nodeId: 'plan',
      profileName: 'delivery-default',
      primaryExecutor: 'claude-code',
      primaryAvailable: true,
      fallbackChain: [],
      satisfiable: true,
    },
  ],
  expectedSideEffects: [
    {
      nodeId: 'plan',
      kind: 'agent-session',
      description: "agent session would run for node 'plan' with profile 'delivery-default'",
    },
  ],
  blockers: [{ kind: 'workflow-not-enabled', message: "workflow 'autonomous-delivery' is draft" }],
}

describe('EvaluatePanel', () => {
  it('renders the mocked report: path chips, blockers, and labels', async () => {
    const runEvaluate = vi.fn().mockResolvedValue(report)
    render(<EvaluatePanel workflowName="autonomous-delivery" runEvaluate={runEvaluate} />)

    expect(screen.getByText('Side-effect-free')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'work item external id' }), {
      target: { value: 'fake:ISSUE-9' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))

    // Node ids appear both as path chips and inside other report sections.
    expect((await screen.findAllByText('dor')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('plan').length).toBeGreaterThan(0)
    expect(screen.getByText('implement')).toBeInTheDocument()
    expect(screen.getByText('indeterminate:implement')).toBeInTheDocument()
    expect(screen.getByText(/workflow 'autonomous-delivery' is draft/)).toBeInTheDocument()
    expect(screen.getByText('described, not executed')).toBeInTheDocument()
    expect(screen.getByText(/resolved by item-metadata/)).toBeInTheDocument()
    expect(screen.getByText('has-description')).toBeInTheDocument()
    expect(runEvaluate).toHaveBeenCalledWith({
      workflowName: 'autonomous-delivery',
      itemExternalId: 'fake:ISSUE-9',
    })
  })

  it('rejects malformed JSON inputs before calling the daemon', async () => {
    const runEvaluate = vi.fn()
    render(<EvaluatePanel workflowName="mini" runEvaluate={runEvaluate} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'work item external id' }), {
      target: { value: 'fake:ISSUE-1' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'evaluate variables JSON' }), {
      target: { value: '{not json' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))
    expect(await screen.findByText(/variables:/)).toBeInTheDocument()
    expect(runEvaluate).not.toHaveBeenCalled()
  })

  it('requires a work item id', async () => {
    const runEvaluate = vi.fn()
    render(<EvaluatePanel workflowName="mini" runEvaluate={runEvaluate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))
    expect(await screen.findByText(/external id is required/)).toBeInTheDocument()
    expect(runEvaluate).not.toHaveBeenCalled()
  })
})
