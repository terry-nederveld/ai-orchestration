/** Fake-fetch helpers shared across this package's tests. No real network I/O. */

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function textErrorResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers })
}

/** A fetchImpl that dispatches to a handler per call, for tests that need routing by URL/body. */
export function routedFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch
}

export type FetchCall = { readonly url: string; readonly init: RequestInit }

/** A scripted fetchImpl that returns queued responses in order and records every call. */
export function fakeFetch(responses: readonly Response[]): {
  readonly fetchImpl: typeof fetch
  readonly calls: FetchCall[]
} {
  const queue = [...responses]
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const response = queue.shift()
    if (!response) throw new Error('fakeFetch: no more scripted responses')
    return response
  }) as typeof fetch
  return { fetchImpl, calls }
}

interface FakeIssueRecord {
  id: number
  number: number
  node_id: string
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  html_url: string
  updated_at: string
  pull_request?: unknown
}

export interface FakeIssueSeed {
  readonly title: string
  readonly body?: string
  readonly state?: 'open' | 'closed'
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  readonly isPullRequest?: boolean
}

function serializeIssue(issue: FakeIssueRecord) {
  return {
    id: issue.id,
    number: issue.number,
    node_id: issue.node_id,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login, id: 1 })),
    html_url: issue.html_url,
    updated_at: issue.updated_at,
    ...(issue.pull_request !== undefined ? { pull_request: issue.pull_request } : {}),
  }
}

/**
 * An in-memory stand-in for the slice of the GitHub REST API that
 * GitHubIssuesWorkProvider talks to: issue list/get/patch, labels, assignees,
 * and comments, plus `/user`. Backs both the unit tests below and the shared
 * WorkProvider contract suite (see contract.test.ts) via its `fetchImpl`.
 */
export class FakeGitHubBackend {
  readonly viewerLogin = 'octocat'
  private nextNumber = 1
  private nextCommentId = 1
  private readonly issues = new Map<number, FakeIssueRecord>()
  private readonly comments = new Map<number, { id: number; body: string; created_at: string }[]>()
  private readonly subIssues = new Map<number, number[]>()

  constructor(private readonly repo: string) {}

  addIssue(seed: FakeIssueSeed): number {
    const number = this.nextNumber++
    this.issues.set(number, {
      id: 1000 + number,
      number,
      node_id: `issue_node_${number}`,
      title: seed.title,
      body: seed.body ?? null,
      state: seed.state ?? 'open',
      labels: [...(seed.labels ?? [])],
      assignees: [...(seed.assignees ?? [])],
      html_url: `https://github.com/${this.repo}/issues/${number}`,
      updated_at: new Date().toISOString(),
      ...(seed.isPullRequest ? { pull_request: {} } : {}),
    })
    this.comments.set(number, [])
    return number
  }

  labelsOf(number: number): readonly string[] {
    return this.issues.get(number)?.labels ?? []
  }

  bodyOf(number: number): string | null {
    return this.issues.get(number)?.body ?? null
  }

  /** Sub-issue numbers registered under a parent via the sub-issues endpoint. */
  subIssuesOf(number: number): readonly number[] {
    return this.subIssues.get(number) ?? []
  }

  /** When false, POST .../sub_issues answers 404 to model repos without sub-issues. */
  subIssuesEnabled = true

  get fetchImpl(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      this.handle(String(input), init ?? {})) as typeof fetch
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const u = new URL(url)
    const path = u.pathname

    if (path === '/user' && method === 'GET') {
      return jsonResponse(200, { login: this.viewerLogin, id: 1 })
    }

    const listMatch = /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(path)
    if (listMatch && method === 'GET') return this.handleList(u)
    if (listMatch && method === 'POST') return this.handleCreate(init)

    const subIssuesMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/sub_issues$/.exec(path)
    if (subIssuesMatch?.[1] && method === 'POST') {
      return this.handleAddSubIssue(Number(subIssuesMatch[1]), init)
    }

    const singleMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path)
    if (singleMatch?.[1]) return this.handleSingle(Number(singleMatch[1]), method, init)

    const labelsMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(path)
    if (labelsMatch?.[1] && method === 'POST')
      return this.handleAddLabels(Number(labelsMatch[1]), init)

    const labelDeleteMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/([^/]+)$/.exec(path)
    if (labelDeleteMatch?.[1] && labelDeleteMatch[2] && method === 'DELETE') {
      return this.handleRemoveLabel(
        Number(labelDeleteMatch[1]),
        decodeURIComponent(labelDeleteMatch[2]),
      )
    }

    const assigneesMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/assignees$/.exec(path)
    if (assigneesMatch?.[1] && method === 'POST') {
      return this.handleAddAssignees(Number(assigneesMatch[1]), init)
    }

    const commentsMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path)
    if (commentsMatch?.[1]) return this.handleComments(Number(commentsMatch[1]), method, init)

    return jsonResponse(404, { message: `no fake route for ${method} ${path}` })
  }

  private handleList(u: URL): Response {
    const state = u.searchParams.get('state') ?? 'open'
    const labelsParam = u.searchParams.get('labels')
    const perPage = Number(u.searchParams.get('per_page') ?? '30')
    const page = Number(u.searchParams.get('page') ?? '1')

    let issues = [...this.issues.values()].sort((a, b) => a.number - b.number)
    if (state !== 'all') issues = issues.filter((i) => i.state === state)
    if (labelsParam) {
      const required = labelsParam.split(',')
      issues = issues.filter((i) => required.every((l) => i.labels.includes(l)))
    }

    const start = (page - 1) * perPage
    const pageItems = issues.slice(start, start + perPage)
    const headers: Record<string, string> = {}
    if (start + perPage < issues.length) {
      const nextUrl = new URL(u.toString())
      nextUrl.searchParams.set('page', String(page + 1))
      headers.link = `<${nextUrl.toString()}>; rel="next"`
    }
    return jsonResponse(200, pageItems.map(serializeIssue), headers)
  }

  private handleCreate(init: RequestInit): Response {
    const body = JSON.parse(String(init.body ?? '{}')) as {
      title: string
      body?: string
      labels?: string[]
    }
    const number = this.addIssue({
      title: body.title,
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.labels !== undefined ? { labels: body.labels } : {}),
    })
    const issue = this.issues.get(number)
    if (!issue) return jsonResponse(500, { message: 'fake backend lost the created issue' })
    return jsonResponse(201, serializeIssue(issue))
  }

  private handleAddSubIssue(parentNumber: number, init: RequestInit): Response {
    if (!this.subIssuesEnabled) return jsonResponse(404, { message: 'Not Found' })
    const parent = this.issues.get(parentNumber)
    if (!parent) return jsonResponse(404, { message: 'Not Found' })
    const body = JSON.parse(String(init.body ?? '{}')) as { sub_issue_id: number }
    const child = [...this.issues.values()].find((i) => i.id === body.sub_issue_id)
    if (!child) return jsonResponse(404, { message: 'Sub-issue not found' })
    const list = this.subIssues.get(parentNumber) ?? []
    if (!list.includes(child.number)) list.push(child.number)
    this.subIssues.set(parentNumber, list)
    return jsonResponse(201, serializeIssue(child))
  }

  private handleSingle(number: number, method: string, init: RequestInit): Response {
    const issue = this.issues.get(number)
    if (!issue) return jsonResponse(404, { message: 'Not Found' })
    if (method === 'GET') return jsonResponse(200, serializeIssue(issue))
    if (method === 'PATCH') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        state?: 'open' | 'closed'
        body?: string
      }
      if (body.state) issue.state = body.state
      if (body.body !== undefined) issue.body = body.body
      return jsonResponse(200, serializeIssue(issue))
    }
    return jsonResponse(405, { message: 'method not allowed' })
  }

  private handleAddLabels(number: number, init: RequestInit): Response {
    const issue = this.issues.get(number)
    if (!issue) return jsonResponse(404, { message: 'Not Found' })
    const body = JSON.parse(String(init.body ?? '{}')) as { labels: string[] }
    for (const l of body.labels) if (!issue.labels.includes(l)) issue.labels.push(l)
    return jsonResponse(
      200,
      issue.labels.map((name) => ({ name })),
    )
  }

  private handleRemoveLabel(number: number, label: string): Response {
    const issue = this.issues.get(number)
    if (!issue) return jsonResponse(404, { message: 'Not Found' })
    const idx = issue.labels.indexOf(label)
    if (idx === -1) return jsonResponse(404, { message: 'Label does not exist' })
    issue.labels.splice(idx, 1)
    return jsonResponse(
      200,
      issue.labels.map((name) => ({ name })),
    )
  }

  private handleAddAssignees(number: number, init: RequestInit): Response {
    const issue = this.issues.get(number)
    if (!issue) return jsonResponse(404, { message: 'Not Found' })
    const body = JSON.parse(String(init.body ?? '{}')) as { assignees: string[] }
    for (const a of body.assignees) if (!issue.assignees.includes(a)) issue.assignees.push(a)
    return jsonResponse(200, serializeIssue(issue))
  }

  private handleComments(number: number, method: string, init: RequestInit): Response {
    const list = this.comments.get(number)
    if (!list) return jsonResponse(404, { message: 'Not Found' })
    if (method === 'GET') return jsonResponse(200, list)
    if (method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { body: string }
      const comment = {
        id: this.nextCommentId++,
        body: body.body,
        created_at: new Date().toISOString(),
      }
      list.push(comment)
      return jsonResponse(201, comment)
    }
    return jsonResponse(405, { message: 'method not allowed' })
  }
}
