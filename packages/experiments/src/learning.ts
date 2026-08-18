/**
 * Durable learning capture (mission §13): render an ExperimentRecord as
 * markdown suitable for a work item's managed section. Ordering is
 * deterministic — iterations ascending, candidates in record order.
 */

import type { Candidate, ExperimentRecord } from '@overture/core'

const RISK_PREFIX = 'risk: '

export function renderExperimentLearning(record: ExperimentRecord): string {
  const lines: string[] = []
  lines.push(`# Experiment: ${record.experimentName}`)
  lines.push('')
  lines.push(`**Hypothesis:** ${record.hypothesis}`)
  lines.push('')
  lines.push(`**Status:** ${record.status}${record.conclusion ? ` (${record.conclusion})` : ''}`)
  lines.push('')
  lines.push('## Criteria')
  lines.push('')
  lines.push(
    `- Experiment definition \`${record.experimentName}\` version ${record.experimentVersion}`,
  )
  lines.push(`- Rubric \`${record.rubricName}\` version ${record.rubricVersion}`)
  lines.push('')

  const iterations = [...new Set(record.candidates.map((candidate) => candidate.iteration))].sort(
    (a, b) => a - b,
  )
  for (const iteration of iterations) {
    lines.push(`## Iteration ${iteration}`)
    lines.push('')
    for (const candidate of record.candidates.filter((entry) => entry.iteration === iteration)) {
      lines.push(`- ${describeCandidate(candidate)}`)
    }
    lines.push('')
  }

  const rejected = record.candidates.filter((candidate) => candidate.status === 'killed')
  if (rejected.length > 0) {
    lines.push('## Rejected approaches')
    lines.push('')
    for (const candidate of rejected) {
      lines.push(
        `- "${candidate.title}" (iteration ${candidate.iteration}) — ${candidate.killedBy ?? 'unknown'}: ${candidate.killReason ?? 'no reason recorded'}`,
      )
    }
    lines.push('')
  }

  const selected = record.candidates.find((candidate) => candidate.status === 'advanced')
  if (selected) {
    lines.push('## Selected approach')
    lines.push('')
    lines.push(
      `"${selected.title}" (iteration ${selected.iteration}, weighted score ${(selected.weightedScore ?? 0).toFixed(2)}) — ${selected.summary}`,
    )
    const reason = record.lessons.find((lesson) => lesson.includes(`advanced "${selected.title}"`))
    if (reason) lines.push(`- Why: ${reason}`)
    const risks = selected.evidence
      .filter((entry) => entry.startsWith(RISK_PREFIX))
      .map((entry) => entry.slice(RISK_PREFIX.length))
    for (const risk of risks) lines.push(`- Risk: ${risk}`)
    lines.push('')
  }

  if (record.lessons.length > 0) {
    lines.push('## Lessons')
    lines.push('')
    for (const lesson of record.lessons) {
      lines.push(`- ${lesson}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function describeCandidate(candidate: Candidate): string {
  const score =
    candidate.weightedScore !== undefined
      ? ` (weighted score ${candidate.weightedScore.toFixed(2)})`
      : ''
  switch (candidate.status) {
    case 'advanced':
      return `**${candidate.title}**${score} — advanced: ${candidate.summary}`
    case 'killed':
      return `**${candidate.title}**${score} — killed by ${candidate.killedBy ?? 'unknown'}: ${candidate.killReason ?? 'no reason recorded'}`
    default:
      return `**${candidate.title}**${score} — ${candidate.status}: ${candidate.summary}`
  }
}
