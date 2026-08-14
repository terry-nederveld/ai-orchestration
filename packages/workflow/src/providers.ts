/**
 * `WorkflowProvider` implementations: a directory of *.yaml/*.yml files on
 * disk, an in-memory provider for tests, and the built-in default workflow.
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { WorkflowDefinition, WorkflowProvider } from '@overture/core'
import { softwareDevelopmentWorkflowYaml } from './builtin-workflows.js'
import { parseWorkflowYaml } from './parser.js'

const YAML_EXTENSIONS = new Set(['.yaml', '.yml'])

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Loads workflow definitions from `*.yaml`/`*.yml` files in a directory. */
export class DirectoryWorkflowProvider implements WorkflowProvider {
  readonly id: string
  private readonly directory: string

  constructor(directory: string, id = 'directory') {
    this.directory = directory
    this.id = id
  }

  async list(): Promise<readonly WorkflowDefinition[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if (isNotFoundError(error)) return []
      throw error
    }
    const files = entries.filter((name) => YAML_EXTENSIONS.has(extname(name))).sort()
    const definitions: WorkflowDefinition[] = []
    for (const file of files) {
      const text = await readFile(join(this.directory, file), 'utf8')
      definitions.push(parseWorkflowYaml(text, file))
    }
    return definitions
  }

  async get(name: string): Promise<WorkflowDefinition | undefined> {
    const definitions = await this.list()
    return definitions.find((definition) => definition.name === name)
  }
}

/** In-memory `WorkflowProvider` for tests and simulation runs. */
export class InMemoryWorkflowProvider implements WorkflowProvider {
  readonly id: string
  private readonly definitions: Map<string, WorkflowDefinition>

  constructor(definitions: readonly WorkflowDefinition[] = [], id = 'in-memory') {
    this.id = id
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]))
  }

  async list(): Promise<readonly WorkflowDefinition[]> {
    return [...this.definitions.values()]
  }

  async get(name: string): Promise<WorkflowDefinition | undefined> {
    return this.definitions.get(name)
  }

  set(definition: WorkflowDefinition): void {
    this.definitions.set(definition.name, definition)
  }
}

let cachedBuiltinSoftwareDevelopmentWorkflow: WorkflowDefinition | undefined

/** The built-in `software-development` workflow, parsed lazily and cached. */
export function getBuiltinSoftwareDevelopmentWorkflow(): WorkflowDefinition {
  if (!cachedBuiltinSoftwareDevelopmentWorkflow) {
    cachedBuiltinSoftwareDevelopmentWorkflow = parseWorkflowYaml(
      softwareDevelopmentWorkflowYaml,
      'software-development.yaml',
    )
  }
  return cachedBuiltinSoftwareDevelopmentWorkflow
}

/** A ready-to-use provider exposing just the built-in workflows. */
export function createBuiltinWorkflowProvider(): WorkflowProvider {
  return new InMemoryWorkflowProvider([getBuiltinSoftwareDevelopmentWorkflow()], 'builtin')
}
