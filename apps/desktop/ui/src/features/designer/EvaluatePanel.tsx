/**
 * Side-effect-free Evaluate (ADR-0026): dry-run the workflow against a
 * work item and render the full report — blockers first, then the
 * determinable path, gate previews, repositories, instructions, profiles,
 * and the side effects that WOULD occur, explicitly labeled as described,
 * never executed.
 */

import { Fragment, useState } from 'react'
import { Badge, type BadgeTone } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import styles from './designer.module.css'
import type { EvaluateRequestBody, EvaluationReportView, GatePreviewOutcome } from './types'

export interface EvaluatePanelProps {
  readonly workflowName: string
  readonly runEvaluate: (body: EvaluateRequestBody) => Promise<EvaluationReportView>
}

const GATE_TONES: Record<GatePreviewOutcome, BadgeTone> = {
  pass: 'success',
  fail: 'danger',
  indeterminate: 'warning',
}

function parseJsonInput(
  label: string,
  text: string,
): { value?: Readonly<Record<string, unknown>>; error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `${label} must be a JSON object` }
    }
    return { value: parsed as Record<string, unknown> }
  } catch (error) {
    return { error: `${label}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function EvaluatePanel({ workflowName, runEvaluate }: EvaluatePanelProps): JSX.Element {
  const [itemExternalId, setItemExternalId] = useState('')
  const [variablesText, setVariablesText] = useState('')
  const [hypotheticalsText, setHypotheticalsText] = useState('')
  const [report, setReport] = useState<EvaluationReportView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    const variables = parseJsonInput('variables', variablesText)
    const hypotheticals = parseJsonInput('hypothetical outputs', hypotheticalsText)
    const inputError = variables.error ?? hypotheticals.error
    if (inputError) {
      setError(inputError)
      return
    }
    if (itemExternalId.trim() === '') {
      setError('a work item external id is required')
      return
    }
    setRunning(true)
    setError(null)
    setReport(null)
    try {
      setReport(
        await runEvaluate({
          workflowName,
          itemExternalId: itemExternalId.trim(),
          ...(variables.value ? { variables: variables.value } : {}),
          ...(hypotheticals.value
            ? {
                hypotheticalOutputs: hypotheticals.value as Readonly<
                  Record<string, Readonly<Record<string, unknown>>>
                >,
              }
            : {}),
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card
      title="Evaluate"
      subtitle="Dry-run this workflow against a work item: nothing is claimed, started, or written."
      actions={<Badge tone="success">Side-effect-free</Badge>}
    >
      <div className={styles.evaluateForm}>
        <div>
          <div className={styles.fieldLabel}>work item external id (e.g. github:ISSUE-42)</div>
          <input
            className={styles.textInput}
            value={itemExternalId}
            onChange={(event) => setItemExternalId(event.target.value)}
            aria-label="work item external id"
            spellCheck={false}
          />
        </div>
        <div>
          <div className={styles.fieldLabel}>variables (optional JSON object)</div>
          <textarea
            className={[styles.jsonArea, styles.evaluateJson].join(' ')}
            value={variablesText}
            onChange={(event) => setVariablesText(event.target.value)}
            aria-label="evaluate variables JSON"
            spellCheck={false}
            placeholder='{"stop_after": "prd"}'
          />
        </div>
        <div>
          <div className={styles.fieldLabel}>
            hypothetical node outputs (optional JSON object, nodeId → outputs)
          </div>
          <textarea
            className={[styles.jsonArea, styles.evaluateJson].join(' ')}
            value={hypotheticalsText}
            onChange={(event) => setHypotheticalsText(event.target.value)}
            aria-label="hypothetical outputs JSON"
            spellCheck={false}
            placeholder='{"review": {"approved": true}}'
          />
        </div>
        <div>
          <Button variant="primary" loading={running} onClick={() => void run()}>
            Evaluate
          </Button>
        </div>
        {error && <div className={styles.errorText}>{error}</div>}
      </div>

      {report && <ReportView report={report} />}
    </Card>
  )
}

function ReportView({ report }: { readonly report: EvaluationReportView }): JSX.Element {
  const stopTone: BadgeTone = report.path.stopReason.startsWith('terminal:')
    ? 'success'
    : report.path.stopReason.startsWith('indeterminate:')
      ? 'warning'
      : 'danger'
  return (
    <div>
      <div className={styles.reportSection}>
        <div className={styles.reportRow}>
          <strong>
            {report.workflow.name}@{report.workflow.version}
          </strong>
          <Badge tone={report.workflow.lifecycle === 'enabled' ? 'success' : 'warning'}>
            {report.workflow.lifecycle}
          </Badge>
          <span className={styles.muted}>{report.matching.rationale}</span>
        </div>
      </div>

      {report.blockers.length > 0 && (
        <div className={styles.reportSection}>
          <div className={styles.reportSectionTitle}>
            Blockers <Badge tone="danger">{report.blockers.length}</Badge>
          </div>
          {report.blockers.map((blocker) => (
            <div key={`${blocker.kind}:${blocker.message}`} className={styles.blocker}>
              <strong>{blocker.kind}</strong> — {blocker.message}
            </div>
          ))}
        </div>
      )}

      {report.workflow.validationIssues.length > 0 && (
        <div className={styles.reportSection}>
          <div className={styles.reportSectionTitle}>Validation issues</div>
          {report.workflow.validationIssues.map((issue) => (
            <div key={`${issue.path}:${issue.message}`} className={styles.issue}>
              {issue.path}: {issue.message}
            </div>
          ))}
        </div>
      )}

      <div className={styles.reportSection}>
        <div className={styles.reportSectionTitle}>Determinable path</div>
        {report.path.nodes.length === 0 ? (
          <div className={styles.muted}>No path could be walked.</div>
        ) : (
          <div className={styles.pathChips}>
            {report.path.nodes.map((nodeId, index) => (
              <Fragment key={`${nodeId}-${String(index)}`}>
                {index > 0 && (
                  <span className={styles.pathArrow} aria-hidden="true">
                    →
                  </span>
                )}
                <span className={styles.pathChip}>{nodeId}</span>
              </Fragment>
            ))}
          </div>
        )}
        <div className={styles.reportRow}>
          <span className={styles.muted}>stopped:</span>
          <Badge tone={stopTone}>{report.path.stopReason}</Badge>
        </div>
      </div>

      {report.gates.length > 0 && (
        <div className={styles.reportSection}>
          <div className={styles.reportSectionTitle}>Gate previews</div>
          {report.gates.map((gateNode) => (
            <div key={gateNode.nodeId}>
              <div className={styles.reportRow}>
                <strong>{gateNode.nodeId}</strong>
                <span className={styles.mono}>
                  {gateNode.gateSetName}@{gateNode.gateSetVersion}
                </span>
              </div>
              {gateNode.gates.map((gate) => (
                <div key={gate.gateId} className={styles.reportRow}>
                  <Badge tone={GATE_TONES[gate.outcome]}>{gate.outcome}</Badge>
                  <span className={styles.mono}>{gate.gateId}</span>
                  {gate.required && <Badge tone="neutral">required</Badge>}
                  <span className={styles.muted}>{gate.reason}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className={styles.reportSection}>
        <div className={styles.reportSectionTitle}>Repositories</div>
        {report.repositories.resolved.length === 0 ? (
          <div className={styles.muted}>No repository resolved for this item.</div>
        ) : (
          report.repositories.resolved.map((entry) => (
            <div key={`${entry.repository.locator}#${entry.role}`} className={styles.reportRow}>
              <span className={styles.mono}>{entry.repository.locator}</span>
              <Badge tone="neutral">{entry.role}</Badge>
              <span className={styles.muted}>resolved by {entry.resolvedBy}</span>
            </div>
          ))
        )}
      </div>

      {report.instructions.length > 0 && (
        <div className={styles.reportSection}>
          <div className={styles.reportSectionTitle}>Instructions</div>
          {report.instructions.map((instruction) => (
            <div key={`${instruction.providerId}:${instruction.path}`} className={styles.reportRow}>
              <span className={styles.mono}>{instruction.path}</span>
              <Badge tone="neutral">{instruction.scope}</Badge>
              <span className={styles.muted}>
                {instruction.source} · precedence {instruction.precedence}
              </span>
            </div>
          ))}
        </div>
      )}

      {report.profiles.length > 0 && (
        <div className={styles.reportSection}>
          <div className={styles.reportSectionTitle}>Agent profiles</div>
          {report.profiles.map((profile) => (
            <div key={profile.nodeId} className={styles.reportRow}>
              <strong>{profile.nodeId}</strong>
              <span className={styles.mono}>{profile.profileName}</span>
              <Badge tone={profile.satisfiable ? 'success' : 'danger'}>
                {profile.satisfiable ? 'executor available' : 'no executor'}
              </Badge>
              {profile.primaryExecutor && (
                <span className={styles.muted}>
                  primary {profile.primaryExecutor}
                  {profile.primaryAvailable === false ? ' (unavailable)' : ''}
                </span>
              )}
              {profile.error && <span className={styles.errorText}>{profile.error}</span>}
            </div>
          ))}
        </div>
      )}

      <div className={styles.reportSection}>
        <div className={styles.reportSectionTitle}>
          Expected side effects <Badge tone="warning">described, not executed</Badge>
        </div>
        {report.expectedSideEffects.length === 0 ? (
          <div className={styles.muted}>No side effects on the determinable path.</div>
        ) : (
          report.expectedSideEffects.map((effect, index) => (
            <div key={`${effect.nodeId}-${String(index)}`} className={styles.reportRow}>
              <Badge tone="neutral">{effect.kind}</Badge>
              <span className={styles.mono}>{effect.nodeId}</span>
              <span>{effect.description}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
