import { describe, expect, it } from 'vitest'
import type { JiraIssue } from './jira-types.js'
import { mapIssueToWorkItem, mapStatusCategory } from './mapping.js'

describe('mapIssueToWorkItem', () => {
  it('maps the core fields, id, and browse url', () => {
    const issue: JiraIssue = {
      key: 'PROJ-42',
      fields: {
        summary: 'Fix the thing',
        status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        labels: ['urgent', 'backend'],
        assignee: { accountId: 'acc-1', displayName: 'Ada Lovelace', emailAddress: 'ada@x.com' },
        updated: '2026-08-01T12:00:00.000+0000',
      },
    }

    const item = mapIssueToWorkItem(issue, 'mycompany.atlassian.net')

    expect(item.id).toBe('jira-cloud:PROJ-42')
    expect(item.provider).toBe('jira-cloud')
    expect(item.externalId).toBe('PROJ-42')
    expect(item.title).toBe('Fix the thing')
    expect(item.state).toBe('In Progress')
    expect(item.type).toBe('Bug')
    expect(item.priority).toBe('High')
    expect(item.labels).toEqual(['urgent', 'backend'])
    expect(item.assignees).toEqual([
      { id: 'acc-1', displayName: 'Ada Lovelace', email: 'ada@x.com' },
    ])
    expect(item.url).toBe('https://mycompany.atlassian.net/browse/PROJ-42')
    expect(item.updatedAt).toEqual(new Date('2026-08-01T12:00:00.000+0000'))
  })

  it('extracts description via ADF-to-text conversion', () => {
    const issue: JiraIssue = {
      key: 'PROJ-1',
      fields: {
        summary: 'Has description',
        status: { id: '1', name: 'To Do' },
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text' }] }],
        },
      },
    }
    const item = mapIssueToWorkItem(issue, 'mycompany.atlassian.net')
    expect(item.description).toBe('Body text')
  })

  it('omits description when there is none', () => {
    const issue: JiraIssue = {
      key: 'PROJ-2',
      fields: { summary: 'No description', status: { id: '1', name: 'To Do' } },
    }
    const item = mapIssueToWorkItem(issue, 'mycompany.atlassian.net')
    expect(item.description).toBeUndefined()
  })

  it('maps an unassigned issue to an empty assignees array', () => {
    const issue: JiraIssue = {
      key: 'PROJ-3',
      fields: { summary: 'Unassigned', status: { id: '1', name: 'To Do' }, assignee: null },
    }
    const item = mapIssueToWorkItem(issue, 'mycompany.atlassian.net')
    expect(item.assignees).toEqual([])
  })

  it('defaults labels to an empty array when absent', () => {
    const issue: JiraIssue = {
      key: 'PROJ-4',
      fields: { summary: 'No labels', status: { id: '1', name: 'To Do' } },
    }
    const item = mapIssueToWorkItem(issue, 'mycompany.atlassian.net')
    expect(item.labels).toEqual([])
  })
})

describe('mapStatusCategory', () => {
  it('maps new -> todo, indeterminate -> in-progress, done -> done, else -> other', () => {
    expect(mapStatusCategory('new')).toBe('todo')
    expect(mapStatusCategory('indeterminate')).toBe('in-progress')
    expect(mapStatusCategory('done')).toBe('done')
    expect(mapStatusCategory('something-else')).toBe('other')
    expect(mapStatusCategory(undefined)).toBe('other')
  })
})
