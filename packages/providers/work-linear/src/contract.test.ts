/**
 * Wires the shared WorkProvider contract suite against a fake-GraphQL-backed
 * LinearWorkProvider, so it's held to the same behavioral guarantees as
 * every other provider (fakes included). The fake backend below is a small
 * stateful in-memory Linear team+issues store that answers the same GraphQL
 * documents the real provider sends, keyed by operation name.
 */

import type { WorkItem } from '@overture/core'
import { describeWorkProviderContract } from '@overture/testkit'
import type { LinearIssueFilter, LinearLabel, LinearWorkflowState } from './linear-types.js'
import { LinearWorkProvider } from './provider.js'
import { routedFetch } from './test-helpers.js'

interface FakeIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  stateName: string
  stateType: string
  labelIds: string[]
  assigneeId: string | null
  priority: number
  comments: string[]
}

const TEAM_KEY = 'ENG'

class FakeLinearBackend {
  readonly teamId = 'team-1'
  states: LinearWorkflowState[] = [
    { id: 'state-todo', name: 'Todo', type: 'unstarted' },
    { id: 'state-in-progress', name: 'In Progress', type: 'started' },
    { id: 'state-done', name: 'Done', type: 'completed' },
    { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
  ]
  labels: LinearLabel[] = [{ id: 'label-bug', name: 'bug' }]
  users: Record<string, string> = { 'user-1': 'Ada Lovelace' }
  issues = new Map<string, FakeIssue>()
  private labelSeq = 1

  addIssue(issue: FakeIssue): void {
    this.issues.set(issue.identifier, issue)
  }

  private findByInternalId(id: string): FakeIssue | undefined {
    return [...this.issues.values()].find((issue) => issue.id === id)
  }

  private toGraphIssue(issue: FakeIssue) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: { name: issue.stateName, type: issue.stateType },
      labels: {
        nodes: issue.labelIds.map((id) => this.labels.find((l) => l.id === id)).filter(Boolean),
      },
      assignee: issue.assigneeId
        ? { id: issue.assigneeId, name: this.users[issue.assigneeId] }
        : null,
      priority: issue.priority,
      url: `https://linear.app/acme/issue/${issue.identifier}`,
      updatedAt: '2026-08-01T00:00:00.000Z',
      team: { key: TEAM_KEY },
    }
  }

  private matchesFilter(issue: FakeIssue, filter: LinearIssueFilter | undefined): boolean {
    if (!filter) return true
    if (filter.and) return filter.and.every((clause) => this.matchesFilter(issue, clause))
    if (filter.team && filter.team.key.eq !== TEAM_KEY) return false
    if (filter.state && !filter.state.name.in.includes(issue.stateName)) return false
    if (filter.assignee) {
      if ('null' in filter.assignee) {
        if (issue.assigneeId !== null) return false
      } else if (issue.assigneeId !== filter.assignee.id.eq) {
        return false
      }
    }
    if (filter.labels?.some) {
      const names = issue.labelIds.map((id) => this.labels.find((l) => l.id === id)?.name)
      if (!filter.labels.some.name.in.some((name) => names.includes(name))) return false
    }
    if (filter.labels?.every) {
      const names = issue.labelIds.map((id) => this.labels.find((l) => l.id === id)?.name)
      if (names.some((name) => name && filter.labels?.every?.name.nin.includes(name))) return false
    }
    return true
  }

  handle(
    query: string,
    variables: Record<string, unknown>,
  ): { data?: unknown; errors?: { message: string }[] } {
    if (query.includes('query Viewer')) {
      return { data: { viewer: { id: 'user-1', name: 'Ada Lovelace' } } }
    }

    if (query.includes('query Issues')) {
      const filter = variables.filter as LinearIssueFilter | undefined
      const first = (variables.first as number | undefined) ?? 50
      const nodes = [...this.issues.values()]
        .filter((issue) => this.matchesFilter(issue, filter))
        .slice(0, first)
        .map((issue) => this.toGraphIssue(issue))
      return { data: { issues: { nodes } } }
    }

    if (query.includes('query IssueDescription')) {
      const id = variables.id as string
      const issue = this.issues.get(id) ?? this.findByInternalId(id)
      return {
        data: { issue: issue ? { id: issue.id, description: issue.description } : null },
      }
    }

    if (query.includes('query IssueGet')) {
      const id = variables.id as string
      const issue = this.issues.get(id) ?? this.findByInternalId(id)
      return { data: { issue: issue ? this.toGraphIssue(issue) : null } }
    }

    if (query.includes('query IssueClaimState')) {
      const id = variables.id as string
      const issue = this.findByInternalId(id)
      if (!issue) return { data: { issue: null } }
      return {
        data: {
          issue: {
            id: issue.id,
            labels: {
              nodes: issue.labelIds
                .map((lid) => this.labels.find((l) => l.id === lid))
                .filter(Boolean),
            },
            comments: { nodes: issue.comments.slice(-1).map((body) => ({ body })) },
          },
        },
      }
    }

    if (query.includes('query Team')) {
      const teamKey = variables.teamKey as string
      if (teamKey !== TEAM_KEY) return { data: { team: null } }
      return {
        data: {
          team: { id: this.teamId, states: { nodes: this.states }, labels: { nodes: this.labels } },
        },
      }
    }

    if (query.includes('query IssueId')) {
      const id = variables.id as string
      const issue = this.issues.get(id) ?? this.findByInternalId(id)
      return { data: { issue: issue ? { id: issue.id } : null } }
    }

    if (query.includes('mutation IssueCreate')) {
      const input = variables.input as {
        teamId: string
        title: string
        description?: string
        labelIds?: string[]
        parentId?: string
      }
      const n = this.issues.size + 1
      const issue: FakeIssue = {
        id: `internal-created-${n}`,
        identifier: `${TEAM_KEY}-${100 + n}`,
        title: input.title,
        description: input.description ?? null,
        stateName: 'Todo',
        stateType: 'unstarted',
        labelIds: input.labelIds ?? [],
        assigneeId: null,
        priority: 0,
        comments: [],
      }
      this.addIssue(issue)
      return { data: { issueCreate: { success: true, issue: this.toGraphIssue(issue) } } }
    }

    if (query.includes('mutation IssueRelationCreate')) {
      return { data: { issueRelationCreate: { success: true } } }
    }

    if (query.includes('mutation IssueLabelCreate')) {
      const input = variables.input as { name: string; teamId: string }
      const label = { id: `label-${this.labelSeq++}`, name: input.name }
      this.labels.push(label)
      return { data: { issueLabelCreate: { success: true, issueLabel: label } } }
    }

    if (query.includes('mutation IssueUpdate')) {
      const id = variables.id as string
      const input = variables.input as {
        labelIds?: string[]
        stateId?: string
        description?: string
      }
      const issue = this.findByInternalId(id)
      if (!issue) return { errors: [{ message: `Entity not found: ${id}` }] }
      if (input.labelIds) issue.labelIds = input.labelIds
      if (input.description !== undefined) issue.description = input.description
      if (input.stateId) {
        const state = this.states.find((s) => s.id === input.stateId)
        if (state) {
          issue.stateName = state.name
          issue.stateType = state.type
        }
      }
      return { data: { issueUpdate: { success: true, issue: this.toGraphIssue(issue) } } }
    }

    if (query.includes('mutation CommentCreate')) {
      const input = variables.input as { issueId: string; body: string }
      const issue = this.findByInternalId(input.issueId)
      if (!issue) return { errors: [{ message: `Entity not found: ${input.issueId}` }] }
      issue.comments.push(input.body)
      return {
        data: {
          commentCreate: {
            success: true,
            comment: { id: `comment-${issue.comments.length}`, body: input.body },
          },
        },
      }
    }

    return { errors: [{ message: `unhandled fake Linear operation: ${query.slice(0, 60)}` }] }
  }
}

let backend: FakeLinearBackend

function factory(): LinearWorkProvider {
  backend = new FakeLinearBackend()
  const fetchImpl = routedFetch((_url, init) => {
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string
      variables?: Record<string, unknown>
    }
    const result = backend.handle(query, variables ?? {})
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return new LinearWorkProvider({
    apiKey: async () => 'lin_api_contract_test',
    teamKey: TEAM_KEY,
    fetchImpl,
  })
}

async function seed(provider: LinearWorkProvider): Promise<readonly WorkItem[]> {
  backend.addIssue({
    id: 'internal-1',
    identifier: 'ENG-1',
    title: 'First issue',
    description: 'the first one',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelIds: ['label-bug'],
    assigneeId: null,
    priority: 2,
    comments: [],
  })
  backend.addIssue({
    id: 'internal-2',
    identifier: 'ENG-2',
    title: 'Second issue',
    description: null,
    stateName: 'In Progress',
    stateType: 'started',
    labelIds: [],
    assigneeId: 'user-1',
    priority: 1,
    comments: [],
  })
  return provider.discover({})
}

describeWorkProviderContract('LinearWorkProvider', factory, seed)
