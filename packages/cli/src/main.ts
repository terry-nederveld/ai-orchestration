#!/usr/bin/env node
/**
 * overture — command-line interface. Every command except `daemon`,
 * `secrets`, and `config` is a thin client of the local daemon's HTTP API.
 */

import { readFile } from 'node:fs/promises'
import { loadConfig, validateConfigObject } from '@overture/config'
import { resolveSecretProvider } from '@overture/secrets'
import { defaultStateDir } from '@overture/server'
import { parse as parseYaml } from 'yaml'
import { ApiError, connect, DaemonClient, DaemonUnavailableError } from './client.js'
import { runDaemon } from './daemon.js'
import { formatDate, renderTable, shortId } from './output.js'

interface Context {
  readonly args: string[]
  readonly stateDir: string
}

type Command = (context: Context) => Promise<number>

const commands: Record<string, { description: string; run: Command }> = {
  daemon: {
    description: 'Run the orchestrator daemon in the foreground',
    run: async (context) => runDaemon(context.args, context.stateDir),
  },
  status: {
    description: 'Show daemon status',
    run: async (context) => {
      const client = await makeClient(context)
      const status = await client.get<{
        version: string
        startedAt: string
        activeRuns: number
        workSources: string[]
        workflows: string[]
      }>('/api/status')
      console.log(`Overture ${status.version}`)
      console.log(`started:      ${formatDate(status.startedAt)}`)
      console.log(`active runs:  ${status.activeRuns}`)
      console.log(`work sources: ${status.workSources.join(', ') || '(none configured)'}`)
      console.log(`workflows:    ${status.workflows.join(', ') || '(none)'}`)
      return 0
    },
  },
  runs: {
    description: 'List and inspect runs (runs [show|cancel|retry|events] [id])',
    run: async (context) => {
      const client = await makeClient(context)
      const [subcommand, id] = context.args
      if (!subcommand || subcommand === 'list') {
        const runs =
          await client.get<
            Array<{
              id: string
              workItemId: string
              workflowName: string
              state: string
              updatedAt: string
            }>
          >('/api/runs')
        if (runs.length === 0) {
          console.log('no runs yet')
          return 0
        }
        console.log(
          renderTable(runs, [
            { header: 'RUN', value: (run) => shortId(run.id) },
            { header: 'WORK ITEM', value: (run) => run.workItemId },
            { header: 'WORKFLOW', value: (run) => run.workflowName },
            { header: 'STATE', value: (run) => run.state },
            { header: 'UPDATED', value: (run) => formatDate(run.updatedAt) },
          ]),
        )
        return 0
      }
      if (!id) {
        console.error(`usage: overture runs ${subcommand} <run-id>`)
        return 2
      }
      if (subcommand === 'show') {
        const run = await client.get<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}`)
        console.log(JSON.stringify(run, null, 2))
        return 0
      }
      if (subcommand === 'cancel') {
        await client.post(`/api/runs/${encodeURIComponent(id)}/cancel`)
        console.log('cancelled')
        return 0
      }
      if (subcommand === 'retry') {
        const run = await client.post<{ id: string }>(`/api/runs/${encodeURIComponent(id)}/retry`)
        console.log(`requeued as ${run.id}`)
        return 0
      }
      if (subcommand === 'events') {
        const events = await client.get<Array<Record<string, unknown>>>(
          `/api/runs/${encodeURIComponent(id)}/events`,
        )
        for (const event of events) {
          console.log(`${formatDate(event.at)}  ${String(event.type)}`)
        }
        return 0
      }
      console.error(`unknown runs subcommand: ${subcommand}`)
      return 2
    },
  },
  run: {
    description: 'Run a work item now: run <source:id> [--workflow name]',
    run: async (context) => {
      const client = await makeClient(context)
      const [ref] = context.args
      if (!ref) {
        console.error('usage: overture run <source:id> [--workflow name]')
        return 2
      }
      const workflow = flagValue(context.args, '--workflow')
      const run = await client.post<{ id: string; workflowName: string }>('/api/runs', {
        workItem: ref,
        ...(workflow ? { workflow } : {}),
      })
      console.log(`started run ${run.id} (workflow: ${run.workflowName})`)
      console.log(`follow with: overture events --run ${run.id}`)
      return 0
    },
  },
  workflows: {
    description: 'List or validate workflows (workflows [list|validate <file>])',
    run: async (context) => {
      const [subcommand, file] = context.args
      if (subcommand === 'validate') {
        if (!file) {
          console.error('usage: overture workflows validate <file>')
          return 2
        }
        const source = await readFile(file, 'utf8')
        const client = await makeClient(context).catch(() => undefined)
        const result = client
          ? await client.post<{ valid: boolean; issues: string[] }>('/api/workflows/validate', {
              source,
            })
          : validateLocally(source)
        if (result.valid) {
          console.log('valid')
          return 0
        }
        for (const issue of result.issues) console.error(`- ${issue}`)
        return 1
      }
      const client = await makeClient(context)
      const workflows =
        await client.get<Array<{ name: string; description?: string }>>('/api/workflows')
      console.log(
        renderTable(workflows, [
          { header: 'NAME', value: (workflow) => workflow.name },
          { header: 'DESCRIPTION', value: (workflow) => workflow.description ?? '' },
        ]),
      )
      return 0
    },
  },
  providers: {
    description: 'Show provider availability and authentication status',
    run: async (context) => {
      const client = await makeClient(context)
      const providers =
        await client.get<
          Array<{
            info: { id: string; displayName: string; kind: string; consumption: string }
            availability: {
              installed: boolean
              authenticated: boolean
              available: boolean
              detail?: string
            }
          }>
        >('/api/providers')
      console.log(
        renderTable(providers, [
          { header: 'PROVIDER', value: (provider) => provider.info.id },
          { header: 'KIND', value: (provider) => provider.info.kind },
          { header: 'BILLING', value: (provider) => provider.info.consumption },
          {
            header: 'STATUS',
            value: (provider) =>
              provider.availability.available
                ? 'available'
                : provider.availability.installed
                  ? 'not authenticated'
                  : 'not installed',
          },
          { header: 'DETAIL', value: (provider) => provider.availability.detail ?? '' },
        ]),
      )
      return 0
    },
  },
  work: {
    description: 'List work items from a source: work <source> [--state s]',
    run: async (context) => {
      const client = await makeClient(context)
      const [source] = context.args
      if (!source) {
        console.error('usage: overture work <source>')
        return 2
      }
      const state = flagValue(context.args, '--state')
      const query = state ? `?state=${encodeURIComponent(state)}` : ''
      const items = await client.get<
        Array<{ externalId: string; title: string; state: string; labels: string[] }>
      >(`/api/work/${encodeURIComponent(source)}/items${query}`)
      console.log(
        renderTable(items, [
          { header: 'ID', value: (item) => item.externalId },
          { header: 'STATE', value: (item) => item.state },
          { header: 'LABELS', value: (item) => item.labels.join(',') },
          { header: 'TITLE', value: (item) => item.title.slice(0, 60) },
        ]),
      )
      return 0
    },
  },
  approvals: {
    description: 'List and resolve pending approvals (approvals [approve|deny <id>])',
    run: async (context) => {
      const client = await makeClient(context)
      const [subcommand, id] = context.args
      if (subcommand === 'approve' || subcommand === 'deny') {
        if (!id) {
          console.error(`usage: overture approvals ${subcommand} <id>`)
          return 2
        }
        await client.post(`/api/approvals/${encodeURIComponent(id)}`, {
          approved: subcommand === 'approve',
        })
        console.log(subcommand === 'approve' ? 'approved' : 'denied')
        return 0
      }
      const approvals =
        await client.get<
          Array<{
            id: string
            requestedAt: string
            request: { capability: string; target?: string }
          }>
        >('/api/approvals')
      if (approvals.length === 0) {
        console.log('no pending approvals')
        return 0
      }
      console.log(
        renderTable(approvals, [
          { header: 'ID', value: (approval) => approval.id },
          { header: 'CAPABILITY', value: (approval) => approval.request.capability },
          { header: 'TARGET', value: (approval) => approval.request.target ?? '' },
          { header: 'REQUESTED', value: (approval) => formatDate(approval.requestedAt) },
        ]),
      )
      return 0
    },
  },
  usage: {
    description: 'Show usage totals for the last 30 days',
    run: async (context) => {
      const client = await makeClient(context)
      const records =
        await client.get<
          Array<{
            provider: string
            model?: string
            tokens: { inputTokens: number; outputTokens: number }
            estimatedCostUsd?: number
            turns: number
          }>
        >('/api/usage')
      if (records.length === 0) {
        console.log('no recorded usage')
        return 0
      }
      console.log(
        renderTable(records, [
          { header: 'PROVIDER', value: (record) => record.provider },
          { header: 'MODEL', value: (record) => record.model ?? '' },
          { header: 'IN', value: (record) => String(record.tokens.inputTokens) },
          { header: 'OUT', value: (record) => String(record.tokens.outputTokens) },
          {
            header: 'EST. COST',
            value: (record) =>
              record.estimatedCostUsd !== undefined ? `$${record.estimatedCostUsd.toFixed(4)}` : '',
          },
          { header: 'TURNS', value: (record) => String(record.turns) },
        ]),
      )
      return 0
    },
  },
  events: {
    description: 'Follow the live event stream (events [--run id])',
    run: async (context) => {
      const client = await makeClient(context)
      const runId = flagValue(context.args, '--run')
      console.error('following events (ctrl-c to stop)…')
      await client.follow(
        (event) => {
          console.log(`${formatDate(event.at)}  ${String(event.type)}`)
        },
        runId ? { runId } : {},
      )
      return 0
    },
  },
  secrets: {
    description: 'Manage stored secrets (secrets set <name> | list | delete <name>)',
    run: async (context) => {
      const provider = await resolveSecretProvider({
        fallbackDirectory: context.stateDir,
      })
      const [subcommand, name] = context.args
      if (subcommand === 'set') {
        if (!name) {
          console.error('usage: overture secrets set <name>   (value read from stdin)')
          return 2
        }
        const value = (await readStdin()).trim()
        if (!value) {
          console.error('no value on stdin')
          return 2
        }
        await provider.set(name, value)
        console.log(`stored ${name} (${provider.id})`)
        return 0
      }
      if (subcommand === 'delete') {
        if (!name) {
          console.error('usage: overture secrets delete <name>')
          return 2
        }
        await provider.delete(name)
        console.log(`deleted ${name}`)
        return 0
      }
      const secrets = await provider.list()
      if (secrets.length === 0) {
        console.log(`no secrets stored (${provider.id})`)
        return 0
      }
      for (const secret of secrets) console.log(secret.name)
      return 0
    },
  },
  config: {
    description: 'Validate configuration (config validate [file])',
    run: async (context) => {
      const [subcommand, file] = context.args
      if (subcommand !== 'validate') {
        console.error('usage: overture config validate [file]')
        return 2
      }
      if (file) {
        const raw = await readFile(file, 'utf8')
        const issues = validateConfigObject(parseYaml(raw))
        if (issues.length === 0) {
          console.log('valid')
          return 0
        }
        for (const issue of issues) console.error(`- ${issue}`)
        return 1
      }
      try {
        const { layers } = await loadConfig({ projectDir: process.cwd() })
        console.log(`valid (${layers.length} layer(s) loaded)`)
        return 0
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 1
      }
    },
  },
}

function validateLocally(source: string): { valid: boolean; issues: string[] } {
  // Deferred import keeps the CLI's fast path light.
  return { valid: false, issues: [`daemon unavailable; cannot validate: ${source.length} bytes`] }
}

async function makeClient(context: Context): Promise<DaemonClient> {
  const connection = await connect(context.stateDir)
  return new DaemonClient(connection)
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1 || index === args.length - 1) return undefined
  return args[index + 1]
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function usage(): void {
  console.log('usage: overture <command> [args]\n')
  console.log('commands:')
  for (const [name, command] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(11)} ${command.description}`)
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [commandName, ...rest] = argv
  if (!commandName || commandName === 'help' || commandName === '--help') {
    usage()
    return commandName ? 0 : 2
  }
  const command = commands[commandName]
  if (!command) {
    console.error(`unknown command: ${commandName}\n`)
    usage()
    return 2
  }
  try {
    return await command.run({ args: rest, stateDir: defaultStateDir() })
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      console.error(error.message)
      return 1
    }
    if (error instanceof ApiError) {
      console.error(`error (${error.status}): ${error.message}`)
      return 1
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

const invokedDirectly =
  process.argv[1]?.endsWith('/main.js') || process.argv[1]?.endsWith('overture')
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
