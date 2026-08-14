import type { WorkQuery } from '@overture/core'
import { describe, expect, it } from 'vitest'
import { buildJql } from './jql.js'

describe('buildJql', () => {
  it('returns the empty ORDER BY clause when the query has no filters', () => {
    expect(buildJql({})).toBe('ORDER BY updated DESC')
  })

  it('uses nativeQuery verbatim, ignoring every other field', () => {
    const query: WorkQuery = {
      nativeQuery: 'project = FOO AND status = "In Review"',
      container: 'BAR',
      states: ['Done'],
    }
    expect(buildJql(query)).toBe('project = FOO AND status = "In Review"')
  })

  it('builds a project clause from query.container', () => {
    expect(buildJql({ container: 'PROJ' })).toBe('project = "PROJ" ORDER BY updated DESC')
  })

  it('falls back to the default project key when container is absent', () => {
    expect(buildJql({}, 'DEFAULT')).toBe('project = "DEFAULT" ORDER BY updated DESC')
  })

  it('prefers query.container over the default project key', () => {
    expect(buildJql({ container: 'PROJ' }, 'DEFAULT')).toBe(
      'project = "PROJ" ORDER BY updated DESC',
    )
  })

  it('builds a status IN clause from states', () => {
    expect(buildJql({ states: ['To Do', 'In Progress'] })).toBe(
      'status IN ("To Do", "In Progress") ORDER BY updated DESC',
    )
  })

  it('builds a conjunction of labels = clauses for labelsInclude', () => {
    expect(buildJql({ labelsInclude: ['urgent', 'backend'] })).toBe(
      'labels = "urgent" AND labels = "backend" ORDER BY updated DESC',
    )
  })

  it('builds an IS EMPTY OR NOT IN clause for labelsExclude', () => {
    expect(buildJql({ labelsExclude: ['wontfix', 'stale'] })).toBe(
      '(labels IS EMPTY OR labels NOT IN ("wontfix", "stale")) ORDER BY updated DESC',
    )
  })

  it('maps assignee "unassigned" to assignee IS EMPTY', () => {
    expect(buildJql({ assignee: 'unassigned' })).toBe('assignee IS EMPTY ORDER BY updated DESC')
  })

  it('maps a concrete assignee to an equality clause', () => {
    expect(buildJql({ assignee: 'jdoe' })).toBe('assignee = "jdoe" ORDER BY updated DESC')
  })

  it('joins every clause with AND in a stable order', () => {
    const query: WorkQuery = {
      container: 'PROJ',
      states: ['To Do'],
      labelsInclude: ['urgent'],
      labelsExclude: ['stale'],
      assignee: 'unassigned',
    }
    expect(buildJql(query)).toBe(
      'project = "PROJ" AND status IN ("To Do") AND labels = "urgent" AND ' +
        '(labels IS EMPTY OR labels NOT IN ("stale")) AND assignee IS EMPTY ORDER BY updated DESC',
    )
  })

  it('escapes embedded quotes in string literals', () => {
    expect(buildJql({ container: 'foo"bar' })).toBe('project = "foo\\"bar" ORDER BY updated DESC')
  })

  it('never emits an empty states IN () clause for an empty array', () => {
    expect(buildJql({ states: [] })).toBe('ORDER BY updated DESC')
  })
})
