import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, type RunId, systemClock } from '@overture/core'
import { ConventionInstructionProvider } from '@overture/resolution'
import { makeWorkItem } from '@overture/testkit'
import { describe, expect, it } from 'vitest'
import { DefaultSpecBuilder, extractChecklist } from './spec-builder.js'

const runId = asId('run-1') as RunId

describe('DefaultSpecBuilder', () => {
  it('resolves repositories: explicit item metadata first, then mapping rules', async () => {
    const builder = new DefaultSpecBuilder({
      clock: systemClock,
      mapping: {
        name: 'test',
        rules: [
          {
            id: 'frontend-label',
            priority: 10,
            when: { condition: { field: 'labels', operator: 'equals', value: 'frontend' } },
            repositories: [{ repository: { locator: 'acme/web' }, role: 'frontend' }],
          },
          {
            id: 'never-matches',
            priority: 5,
            when: { condition: { field: 'type', operator: 'equals', value: 'epic' } },
            repositories: [{ repository: { locator: 'acme/infra' }, role: 'infra' }],
          },
        ],
      },
    })
    const item = makeWorkItem({
      title: 'Fix header',
      labels: ['frontend'],
      repository: { locator: 'acme/app' },
    })
    const spec = await builder.build({
      runId,
      item,
      snapshotId: 'snap-1',
      revision: 1,
      reason: 'initial',
    })
    expect(spec.repositories).toEqual([
      { repository: { locator: 'acme/app' }, role: 'primary', resolvedBy: 'explicit' },
      { repository: { locator: 'acme/web' }, role: 'frontend', resolvedBy: 'rule:frontend-label' },
    ])
  })

  it('records discovered instructions with provenance and applied flags', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'spec-builder-'))
    await writeFile(join(workspace, 'CLAUDE.md'), '# Conventions\nUse tabs.')
    await writeFile(join(workspace, 'AGENTS.md'), '# Agents\nBe careful.')

    const builder = new DefaultSpecBuilder({
      clock: systemClock,
      instructions: [new ConventionInstructionProvider()],
    })
    const spec = await builder.build({
      runId,
      item: makeWorkItem({ title: 'Task' }),
      snapshotId: 'snap-1',
      revision: 1,
      reason: 'initial',
      workspacePath: workspace,
    })
    const sources = spec.instructions.map((instruction) => instruction.source).sort()
    expect(sources).toContain('CLAUDE.md')
    expect(sources).toContain('AGENTS.md')
    expect(spec.instructions.every((instruction) => instruction.contentHash.length > 0)).toBe(true)
    expect(spec.instructions.every((instruction) => instruction.applied)).toBe(true)
  })

  it('extracts markdown task-list items as acceptance criteria', async () => {
    const builder = new DefaultSpecBuilder({ clock: systemClock })
    const item = makeWorkItem({
      title: 'Add export',
      description:
        'Please add CSV export.\n\n- [ ] exports all rows\n- [x] handles commas\n- not a task',
    })
    const spec = await builder.build({
      runId,
      item,
      snapshotId: 'snap-1',
      revision: 1,
      reason: 'initial',
    })
    expect(spec.acceptanceCriteria).toEqual(['exports all rows', 'handles commas'])
    expect(spec.goal).toContain('Add export')
    expect(spec.goal).toContain('CSV export')
  })

  it('extractChecklist ignores non-task lines', () => {
    expect(extractChecklist('- [ ] a\n* [X] b\n- plain\ntext')).toEqual(['a', 'b'])
  })
})
