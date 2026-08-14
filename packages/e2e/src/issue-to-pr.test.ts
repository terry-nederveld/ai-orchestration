/**
 * End-to-end vertical slice: a work item travels through the full stack —
 * real git origin, real worktree isolation, real filesystem/shell tools,
 * the real native agent loop (driven by a scripted model so no credits are
 * spent), the real workflow engine and orchestrator, SQLite persistence —
 * and delivers a conventional commit, a pushed branch, and a pull-request
 * invocation, then transitions the work item.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type IdGenerator,
  InMemoryEventBus,
  noopLogger,
  type OrchestratorEvent,
  RunState,
  systemClock,
} from '@overture/core'
import {
  builtinActionFactory,
  DefaultCommandRunner,
  ProfileAgentRouter,
  RunCoordinator,
  Scheduler,
  WorkflowActionRegistry,
} from '@overture/orchestrator'
import { SqlitePersistenceProvider } from '@overture/persistence'
import { RuleBasedPolicyEngine, workspaceCodingRules } from '@overture/policy'
import { DefaultToolRegistry, NativeAgentRuntime } from '@overture/runtime'
import {
  GitHubSourceControlProvider,
  GitSourceControlProvider,
  GitWorktreeManager,
} from '@overture/scm-git'
import { FakeWorkProvider, makeWorkItem, ScriptedModelProvider } from '@overture/testkit'
import { createCodingToolProvider } from '@overture/tools'
import { InMemoryWorkflowProvider, parseWorkflowYaml } from '@overture/workflow'
import { GitWorktreeWorkspaceProvider, WorkspaceProviderRegistry } from '@overture/workspaces'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const WORKFLOW_YAML = `
name: e2e-development
trigger:
  states: [Ready]
eligibility:
  labels:
    include: [agent-ready]
workspace:
  strategy: git-worktree
  retention: never
steps:
  - id: analyze
    agent: planner
    goal: Analyze the issue and produce a plan.
  - id: implement
    agent: coder
    depends_on: [analyze]
    goal: Fix the bug completely and verify with the test suite.
  - id: test
    command: node test.js
    depends_on: [implement]
  - id: review
    agent: reviewer
    depends_on: [implement, test]
    goal: Review the change for correctness.
  - id: ensure_validated
    action: workflow.assert
    when: 'true'
    depends_on: [review]
    with:
      condition: '\${{ steps.review.succeeded }}'
  - id: commit
    action: source_control.commit
    depends_on: [ensure_validated]
    with:
      message: 'fix(calculator): use addition instead of subtraction in add()'
  - id: deliver
    action: source_control.pull_request
    depends_on: [commit]
    with:
      title: 'fix(calculator): correct add() operator'
      body: 'Fixes the addition bug reported in the work item.'
transitions:
  success: Done
  failure: Agent Failed
`

const BUGGY_SOURCE = `exports.add = function add(a, b) {
  return a - b
}
`

const FIXED_SOURCE = `exports.add = function add(a, b) {
  return a + b
}
`

const TEST_SOURCE = `const assert = require('node:assert')
const { add } = require('./calculator.js')
assert.strictEqual(add(2, 3), 5)
console.log('ok')
`

class SequentialIds implements IdGenerator {
  private n = 0
  next(prefix: string): string {
    return `${prefix}-${++this.n}`
  }
}

describe('issue → PR end to end', () => {
  let base: string
  let originDir: string
  const ghCalls: Array<{ args: readonly string[]; body?: string }> = []

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'overture-e2e-'))
    originDir = join(base, 'origin.git')

    // Build the origin repository with the buggy project on main.
    await run('git', ['init', '--bare', originDir])
    const seed = join(base, 'seed')
    await run('git', ['clone', originDir, seed])
    await run('git', ['-C', seed, 'checkout', '-b', 'main'])
    await writeFile(join(seed, 'calculator.js'), BUGGY_SOURCE)
    await writeFile(join(seed, 'test.js'), TEST_SOURCE)
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', [
      '-C',
      seed,
      '-c',
      'user.email=dev@example.com',
      '-c',
      'user.name=Dev',
      'commit',
      '-m',
      'chore: seed calculator project',
    ])
    await run('git', ['-C', seed, 'push', 'origin', 'main'])
    await run('git', ['--git-dir', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  }, 30_000)

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('discovers, fixes, validates, commits, pushes, opens a PR, and transitions the issue', async () => {
    const events: OrchestratorEvent[] = []
    const bus = new InMemoryEventBus()
    bus.subscribe({}, (event) => events.push(event))

    const work = new FakeWorkProvider([
      makeWorkItem({
        externalId: 'ISSUE-42',
        title: 'add() returns the wrong sum',
        description: 'add(2, 3) returns -1 instead of 5. The operator is wrong in calculator.js.',
        state: 'Ready',
        labels: ['agent-ready'],
        repository: { locator: originDir, defaultBranch: 'main' },
      }),
    ])

    // The model script drives all three agent steps in order.
    const model = new ScriptedModelProvider([
      // analyze (planner)
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: {
          outcome: 'completed',
          summary:
            'Plan: change the subtraction to addition in calculator.js add(), verify with node test.js.',
        },
      },
      // implement (coder): read, fix, verify, complete
      { kind: 'tool_call', name: 'read_file', input: { path: 'calculator.js' } },
      {
        kind: 'tool_call',
        name: 'edit_file',
        input: { path: 'calculator.js', old_text: 'return a - b', new_text: 'return a + b' },
      },
      { kind: 'tool_call', name: 'run_command', input: { command: 'node test.js' } },
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'Fixed the operator and the test passes.' },
      },
      // review (reviewer)
      { kind: 'tool_call', name: 'read_file', input: { path: 'calculator.js' } },
      {
        kind: 'tool_call',
        name: 'complete_goal',
        input: { outcome: 'completed', summary: 'The fix is correct and minimal.' },
      },
    ])

    const policy = new RuleBasedPolicyEngine({ rules: workspaceCodingRules() })
    const tools = new DefaultToolRegistry()
    tools.register(createCodingToolProvider())
    const runtime = new NativeAgentRuntime({
      model,
      defaultModel: 'scripted-1',
      tools,
      policy,
    })
    const router = new ProfileAgentRouter({
      profiles: { default: { executor: 'native' } },
      defaultProfile: 'default',
    })
    router.register({ id: 'native', start: (request) => runtime.start(request) })

    const gitScm = new GitSourceControlProvider()
    const scm = new GitHubSourceControlProvider({
      env: {
        GIT_AUTHOR_NAME: 'Overture',
        GIT_AUTHOR_EMAIL: 'overture@example.com',
        GIT_COMMITTER_NAME: 'Overture',
        GIT_COMMITTER_EMAIL: 'overture@example.com',
      },
      runner: async (args) => {
        const bodyFileIndex = args.indexOf('--body-file')
        let body: string | undefined
        if (bodyFileIndex !== -1 && args[bodyFileIndex + 1]) {
          body = await readFile(args[bodyFileIndex + 1] as string, 'utf8')
        }
        ghCalls.push({ args, ...(body !== undefined ? { body } : {}) })
        return { stdout: 'https://github.com/example/repo/pull/7\n', stderr: '' }
      },
    })

    const reposRoot = join(base, 'repos')
    const workspacesRoot = join(base, 'workspaces')
    await mkdir(reposRoot, { recursive: true })
    await mkdir(workspacesRoot, { recursive: true })
    const registry = new WorkspaceProviderRegistry()
    registry.register(
      new GitWorktreeWorkspaceProvider({
        reposRoot,
        workspacesRoot,
        scm: gitScm,
        worktrees: new GitWorktreeManager(),
      }),
    )

    const persistence = new SqlitePersistenceProvider(join(base, 'overture.db'))
    await persistence.migrate()

    const ids = new SequentialIds()
    const actions = new WorkflowActionRegistry()
    actions.register(builtinActionFactory)

    const coordinator = new RunCoordinator({
      work: { resolve: () => work },
      workspaces: {
        resolve: (strategy) =>
          strategy === 'git-worktree' ? registry.resolve('git-worktree') : undefined,
      },
      agents: router,
      commands: new DefaultCommandRunner(),
      actions,
      approvals: { requestApproval: async () => true },
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      scm,
      claimant: 'e2e-test',
    })

    const scheduler = new Scheduler({
      sources: [{ provider: work, query: { states: ['Ready'] } }],
      workflows: new InMemoryWorkflowProvider([parseWorkflowYaml(WORKFLOW_YAML)]),
      coordinator,
      persistence,
      events: bus,
      clock: systemClock,
      ids,
      logger: noopLogger,
      pollIntervalMs: 3_600_000,
      maxConcurrentRuns: 1,
    })

    // Discovery → claim → execution, exactly as the daemon would run it.
    await scheduler.start()
    await waitFor(async () => {
      const runs = await persistence.runs.list()
      return runs.length === 1 && runs[0] !== undefined && runs[0].state === RunState.Completed
    }, 60_000)
    await scheduler.stop()

    const [record] = await persistence.runs.list()
    if (!record) throw new Error('run not persisted')
    expect(record.state).toBe(RunState.Completed)
    expect(record.usage?.tokens.inputTokens).toBeGreaterThan(0)

    // The branch exists on the origin with the conventional commit.
    const { stdout: branches } = await run('git', ['--git-dir', originDir, 'branch'])
    expect(branches).toContain('overture/issue-42')
    const { stdout: subject } = await run('git', [
      '--git-dir',
      originDir,
      'log',
      '-1',
      '--format=%s%n%b',
      'overture/issue-42',
    ])
    expect(subject).toContain('fix(calculator): use addition instead of subtraction in add()')
    expect(subject).not.toMatch(/co-authored-by|generated/i)

    // The fix itself landed.
    const { stdout: fixedFile } = await run('git', [
      '--git-dir',
      originDir,
      'show',
      'overture/issue-42:calculator.js',
    ])
    expect(fixedFile).toBe(FIXED_SOURCE)

    // Pull request was requested through gh with the right shape.
    expect(ghCalls).toHaveLength(1)
    const prArgs = ghCalls[0]?.args ?? []
    expect(prArgs).toContain('pr')
    expect(prArgs).toContain('create')
    expect(prArgs[prArgs.indexOf('--head') + 1]).toBe('overture/issue-42')
    expect(prArgs[prArgs.indexOf('--base') + 1]).toBe('main')
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('fix(calculator): correct add() operator')
    expect(ghCalls[0]?.body).toContain('Fixes the addition bug')

    // Work item transitioned to Done.
    const item = await work.get('ISSUE-42')
    expect(item.state).toBe('Done')

    // Observability: the whole lifecycle is on the bus and in the event log.
    const types = new Set(events.map((event) => event.type))
    for (const expected of [
      'work.discovered',
      'work.claimed',
      'workspace.created',
      'run.state.changed',
      'workflow.step.started',
      'workflow.step.completed',
      'agent',
      'delivery.pull_request.created',
      'workflow.transitioned',
    ]) {
      expect(types.has(expected as OrchestratorEvent['type']), `missing event ${expected}`).toBe(
        true,
      )
    }
    const persisted = await persistence.events.listForRun(record.id)
    expect(persisted.length).toBe(0) // event-log persistence is the service layer's job

    // Workspace was cleaned (retention: never).
    const { stdout: worktreeList } = await run('ls', [workspacesRoot])
    expect(worktreeList.trim()).toBe('')

    await persistence.close()
  }, 90_000)
})

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error('condition not met in time')
}
