import { describe, expect, it } from 'vitest'
import type { LinearIssue } from './linear-types.js'
import { mapIssueToWorkItem, mapPriority, mapStateCategory, stateToStateInfo } from './mapping.js'

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'internal-uuid-1',
    identifier: 'ENG-123',
    title: 'Fix the thing',
    description: null,
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
    assignee: null,
    priority: 0,
    url: 'https://linear.app/acme/issue/ENG-123',
    updatedAt: '2026-08-01T12:00:00.000Z',
    team: { key: 'ENG' },
    ...overrides,
  }
}

describe('mapPriority', () => {
  it.each([
    [0, 'none'],
    [1, 'urgent'],
    [2, 'high'],
    [3, 'medium'],
    [4, 'low'],
  ])('maps Linear priority %i to %s', (priority, expected) => {
    expect(mapPriority(priority)).toBe(expected)
  })

  it('falls back to none for an unrecognized priority value', () => {
    expect(mapPriority(99)).toBe('none')
  })
})

describe('mapStateCategory', () => {
  it.each([
    ['triage', 'todo'],
    ['backlog', 'todo'],
    ['unstarted', 'todo'],
    ['started', 'in-progress'],
    ['completed', 'done'],
    ['canceled', 'other'],
    ['something-unknown', 'other'],
  ] as const)('maps Linear state type %s to category %s', (type, expected) => {
    expect(mapStateCategory(type)).toBe(expected)
  })
})

describe('stateToStateInfo', () => {
  it("uses the state name as both id and name so it shares WorkItem.state's value space", () => {
    const info = stateToStateInfo({
      id: 'internal-state-uuid',
      name: 'In Progress',
      type: 'started',
    })
    expect(info).toEqual({ id: 'In Progress', name: 'In Progress', category: 'in-progress' })
  })
})

describe('mapIssueToWorkItem', () => {
  it('maps the canonical id, externalId, and title', () => {
    const item = mapIssueToWorkItem(issue())
    expect(item.id).toBe('linear:ENG-123')
    expect(item.provider).toBe('linear')
    expect(item.externalId).toBe('ENG-123')
    expect(item.title).toBe('Fix the thing')
  })

  it('omits description when null and includes it when present', () => {
    expect(mapIssueToWorkItem(issue({ description: null })).description).toBeUndefined()
    expect(mapIssueToWorkItem(issue({ description: 'details' })).description).toBe('details')
  })

  it('maps state to the state name and leaves type undefined (Linear has no issue type)', () => {
    const item = mapIssueToWorkItem(issue({ state: { name: 'In Progress', type: 'started' } }))
    expect(item.state).toBe('In Progress')
    expect(item.type).toBeUndefined()
  })

  it('maps labels to their names', () => {
    const item = mapIssueToWorkItem(
      issue({
        labels: {
          nodes: [
            { id: 'label-1', name: 'bug' },
            { id: 'label-2', name: 'urgent-fix' },
          ],
        },
      }),
    )
    expect(item.labels).toEqual(['bug', 'urgent-fix'])
  })

  it('maps assignee to a single Identity, or an empty array when unassigned', () => {
    const assigned = mapIssueToWorkItem(issue({ assignee: { id: 'user-1', name: 'Ada Lovelace' } }))
    expect(assigned.assignees).toEqual([{ id: 'user-1', displayName: 'Ada Lovelace' }])

    const unassigned = mapIssueToWorkItem(issue({ assignee: null }))
    expect(unassigned.assignees).toEqual([])
  })

  it('maps priority using the shared priority table', () => {
    expect(mapIssueToWorkItem(issue({ priority: 1 })).priority).toBe('urgent')
  })

  it('maps url and updatedAt', () => {
    const item = mapIssueToWorkItem(issue())
    expect(item.url).toBe('https://linear.app/acme/issue/ENG-123')
    expect(item.updatedAt).toEqual(new Date('2026-08-01T12:00:00.000Z'))
  })

  it('stashes the Linear internal id, state type, label ids, and team key in metadata', () => {
    const item = mapIssueToWorkItem(
      issue({
        labels: { nodes: [{ id: 'label-1', name: 'bug' }] },
        team: { key: 'ENG' },
      }),
    )
    expect(item.metadata).toEqual({
      linearId: 'internal-uuid-1',
      stateType: 'unstarted',
      labelIds: ['label-1'],
      teamKey: 'ENG',
    })
  })

  it('omits teamKey from metadata when the issue has no team', () => {
    const item = mapIssueToWorkItem(issue({ team: null }))
    expect(item.metadata.teamKey).toBeUndefined()
  })

  it('always returns an empty relationships array (not requested from the API)', () => {
    expect(mapIssueToWorkItem(issue()).relationships).toEqual([])
  })
})
