import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@overture/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowValidationError } from './errors.js'
import {
  createBuiltinWorkflowProvider,
  DirectoryWorkflowProvider,
  getBuiltinSoftwareDevelopmentWorkflow,
  InMemoryWorkflowProvider,
} from './providers.js'

const MINIMAL_A = `
name: workflow-a
steps:
  - id: only
    command: echo hi
`

const MINIMAL_B = `
name: workflow-b
steps:
  - id: only
    command: echo hi
`

describe('DirectoryWorkflowProvider', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'overture-workflow-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips workflows written to disk as .yaml and .yml', async () => {
    await writeFile(join(dir, 'a.yaml'), MINIMAL_A, 'utf8')
    await writeFile(join(dir, 'b.yml'), MINIMAL_B, 'utf8')
    await writeFile(join(dir, 'not-a-workflow.txt'), 'ignored', 'utf8')

    const provider = new DirectoryWorkflowProvider(dir)
    const definitions = await provider.list()
    expect(definitions.map((d) => d.name).sort()).toEqual(['workflow-a', 'workflow-b'])

    const a = await provider.get('workflow-a')
    expect(a?.steps[0]).toMatchObject({ id: 'only', kind: 'command', command: 'echo hi' })

    expect(await provider.get('does-not-exist')).toBeUndefined()
  })

  it('returns an empty list for a directory that does not exist', async () => {
    const provider = new DirectoryWorkflowProvider(join(dir, 'missing-subdir'))
    expect(await provider.list()).toEqual([])
  })

  it('throws WorkflowValidationError when a file in the directory is invalid', async () => {
    await writeFile(join(dir, 'broken.yaml'), 'name: w\nsteps: []\n', 'utf8')
    const provider = new DirectoryWorkflowProvider(dir)
    await expect(provider.list()).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  it('exposes a stable id', () => {
    expect(new DirectoryWorkflowProvider(dir, 'my-dir').id).toBe('my-dir')
    expect(new DirectoryWorkflowProvider(dir).id).toBe('directory')
  })
})

describe('InMemoryWorkflowProvider', () => {
  function definition(name: string): WorkflowDefinition {
    return { name, steps: [{ id: 'only', kind: 'command', command: 'echo hi' }] }
  }

  it('lists and gets definitions by name', async () => {
    const provider = new InMemoryWorkflowProvider([definition('x'), definition('y')])
    expect((await provider.list()).map((d) => d.name).sort()).toEqual(['x', 'y'])
    expect(await provider.get('x')).toEqual(definition('x'))
    expect(await provider.get('missing')).toBeUndefined()
  })

  it('supports adding/replacing a definition via set', async () => {
    const provider = new InMemoryWorkflowProvider()
    expect(await provider.list()).toEqual([])
    provider.set(definition('z'))
    expect(await provider.get('z')).toEqual(definition('z'))
  })
})

describe('built-in software-development workflow', () => {
  it('parses and validates successfully', () => {
    const workflow = getBuiltinSoftwareDevelopmentWorkflow()
    expect(workflow.name).toBe('software-development')
    expect(workflow.steps.map((s) => s.id)).toEqual([
      'analyze',
      'implement',
      'test',
      'review',
      'remediate',
      're_review',
      'ensure_validated',
      'deliver',
    ])
  })

  it('is parsed once and cached', () => {
    expect(getBuiltinSoftwareDevelopmentWorkflow()).toBe(getBuiltinSoftwareDevelopmentWorkflow())
  })

  it('is exposed through a ready-to-use provider', async () => {
    const provider = createBuiltinWorkflowProvider()
    const workflow = await provider.get('software-development')
    expect(workflow?.name).toBe('software-development')
    expect(await provider.get('nonexistent')).toBeUndefined()
  })
})
