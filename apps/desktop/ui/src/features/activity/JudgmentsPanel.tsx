/**
 * Judgment observability: decisions recorded across all connected runtimes,
 * newest first (GET /api/judgments).
 */

import { useFederatedQuery } from '../../api/federation'
import type { JudgmentDecision, JudgmentOutcome } from '../../api/types'
import type { BadgeTone } from '../../components/Badge'
import { Badge } from '../../components/Badge'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Table } from '../../components/Table'
import { relativeTime, titleCase } from '../../lib/format'

const DECISION_TONE: Record<JudgmentDecision, BadgeTone> = {
  advance: 'success',
  kill: 'danger',
  iterate: 'accent',
  'need-more-evidence': 'warning',
}

interface JudgmentRow {
  readonly connection: string
  readonly stale: boolean
  readonly outcome: JudgmentOutcome
}

export function JudgmentsPanel(): JSX.Element {
  const query = useFederatedQuery('judgments', (c) => c.listJudgments())

  const rows: readonly JudgmentRow[] = query.records
    .flatMap((record) =>
      (record.data ?? []).map((outcome) => ({
        connection: record.connection,
        stale: record.stale,
        outcome,
      })),
    )
    .sort((a, b) => new Date(b.outcome.at).getTime() - new Date(a.outcome.at).getTime())

  return (
    <Card title="Judgment decisions" flush>
      {query.loading && rows.length === 0 ? (
        <div style={{ padding: 'var(--space-6)' }}>
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="⚖"
          title="No judgments recorded"
          hint="Experiment judgment decisions (advance, iterate, kill) land here as they are made."
        />
      ) : (
        <Table
          rows={rows}
          rowKey={(row) =>
            `${row.connection}:${row.outcome.experimentId}:${row.outcome.at}:${row.outcome.decision}`
          }
          columns={[
            {
              key: 'decision',
              header: 'Decision',
              render: (row: JudgmentRow) => (
                <Badge tone={DECISION_TONE[row.outcome.decision]}>
                  {titleCase(row.outcome.decision)}
                </Badge>
              ),
            },
            {
              key: 'experiment',
              header: 'Experiment',
              render: (row: JudgmentRow) => (
                <span className="mono">{row.outcome.experimentId}</span>
              ),
            },
            {
              key: 'candidate',
              header: 'Candidate',
              render: (row: JudgmentRow) =>
                row.outcome.selectedCandidateId ? (
                  <span className="mono">{row.outcome.selectedCandidateId}</span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'decidedBy',
              header: 'Decided by',
              render: (row: JudgmentRow) => row.outcome.decidedBy,
            },
            {
              key: 'connection',
              header: 'Connection',
              render: (row: JudgmentRow) => (
                <>
                  <Badge tone="neutral">{row.connection}</Badge>{' '}
                  {row.stale && <Badge tone="warning">stale</Badge>}
                </>
              ),
            },
            {
              key: 'at',
              header: 'When',
              render: (row: JudgmentRow) => relativeTime(row.outcome.at),
            },
          ]}
        />
      )}
    </Card>
  )
}
