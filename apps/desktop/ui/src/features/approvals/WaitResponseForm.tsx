/**
 * Typed response form for a durable wait's HumanInputRequestSpec: approval
 * buttons, textarea, radio list, checkboxes, or boolean toggle, submitted
 * via POST /api/waits/:id/respond on the wait's owning connection. A lost
 * first-valid-response race (409) shows who won instead of failing silently.
 *
 * Experiment-judgment waits (`parameters.reason` =
 * EXPERIMENT_JUDGMENT_REQUIRED) render their JudgmentPackage above the
 * choices, and `advance:<candidateId>` choices are labeled with the
 * candidate's title.
 */
import { type FormEvent, useMemo, useState } from 'react'
import type { ApiClient } from '../../api/client'
import type { JudgmentPackage, WaitCondition, WaitWinner } from '../../api/types'
import { EXPERIMENT_JUDGMENT_REASON } from '../../api/types'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { useToast } from '../../components/Toast'
import { relativeTime, titleCase } from '../../lib/format'
import styles from './WaitResponseForm.module.css'

export interface WaitResponseFormProps {
  readonly wait: WaitCondition
  /** Client of the connection that owns this wait. */
  readonly client: ApiClient
  /** Disables submission (e.g. the owning runtime is unreachable). */
  readonly disabled?: boolean
  readonly onResolved?: (() => void) | undefined
}

function isJudgmentPackage(value: unknown): value is JudgmentPackage {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as JudgmentPackage).hypothesis === 'string' &&
    Array.isArray((value as JudgmentPackage).survivors)
  )
}

export function judgmentFromWait(wait: WaitCondition): JudgmentPackage | undefined {
  if (wait.parameters.reason !== EXPERIMENT_JUDGMENT_REASON) return undefined
  const judgment = wait.parameters.judgment
  return isJudgmentPackage(judgment) ? judgment : undefined
}

/** Human-readable label for a wait choice, resolving candidate titles. */
export function choiceLabel(choice: string, judgment?: JudgmentPackage): string {
  if (choice.startsWith('advance:')) {
    const candidateId = choice.slice('advance:'.length)
    const survivor = judgment?.survivors.find((s) => s.candidateId === candidateId)
    return survivor ? `Advance — ${survivor.title}` : `Advance — ${candidateId}`
  }
  return titleCase(choice)
}

export function WaitResponseForm({
  wait,
  client,
  disabled = false,
  onResolved,
}: WaitResponseFormProps): JSX.Element {
  const { push } = useToast()
  const [busy, setBusy] = useState(false)
  const [winner, setWinner] = useState<WaitWinner | null>(null)
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<string | null>(null)
  const [checked, setChecked] = useState<readonly string[]>([])
  const [toggled, setToggled] = useState(false)

  const judgment = useMemo(() => judgmentFromWait(wait), [wait])
  const spec = wait.request

  const submit = async (value: unknown) => {
    setBusy(true)
    try {
      const result = await client.respondToWait(wait.id, value)
      if (result.accepted) {
        push('Response sent', 'success')
        onResolved?.()
      } else if (result.status === 409) {
        setWinner(result.winner ?? { at: new Date().toISOString() })
        push('Someone else answered first', 'error')
        onResolved?.()
      } else {
        push(result.error, 'error')
      }
    } catch (err) {
      push(err instanceof Error ? err.message : 'Failed to send response', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (winner) {
    return (
      <div className={styles.conflict}>
        Already answered by {winner.responder ?? 'someone else'} {relativeTime(winner.at)}
        {winner.value !== undefined ? <> — {JSON.stringify(winner.value)}</> : null}. Your response
        was kept as supplemental context.
      </div>
    )
  }

  if (!spec) {
    return (
      <div className={styles.nonHuman}>Waiting on {wait.kind} — no response needed from you.</div>
    )
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    switch (spec.type) {
      case 'text':
      case 'free-form':
      case 'secret':
      case 'file-reference':
        if (text.trim()) void submit(text.trim())
        return
      case 'single-choice':
        if (choice !== null) void submit(choice)
        return
      case 'multiple-choice':
        if (checked.length > 0) void submit([...checked])
        return
      case 'boolean':
        void submit(toggled)
        return
      default:
        return
    }
  }

  return (
    <div className={styles.form}>
      {judgment && <JudgmentPackageView judgment={judgment} />}
      <div className={styles.prompt}>{spec.prompt}</div>

      {spec.type === 'approval' ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={disabled}
            onClick={() => void submit(true)}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            disabled={disabled}
            onClick={() => void submit(false)}
          >
            Decline
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className={styles.form}>
          {spec.type === 'secret' && (
            <input
              type="password"
              className={styles.textarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="secret value (stored securely, never displayed)"
              autoComplete="off"
              disabled={disabled}
            />
          )}

          {(spec.type === 'text' ||
            spec.type === 'free-form' ||
            spec.type === 'file-reference') && (
            <textarea
              className={styles.textarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={spec.type === 'file-reference' ? 'file reference' : 'type your response'}
              disabled={disabled}
            />
          )}

          {spec.type === 'single-choice' && (
            <div className={styles.choices} role="radiogroup">
              {(spec.choices ?? []).map((option) => (
                <label key={option} className={styles.choice}>
                  <input
                    type="radio"
                    name={`wait-${wait.id}`}
                    value={option}
                    checked={choice === option}
                    onChange={() => setChoice(option)}
                    disabled={disabled}
                  />
                  <span>{choiceLabel(option, judgment)}</span>
                </label>
              ))}
            </div>
          )}

          {spec.type === 'multiple-choice' && (
            <div className={styles.choices}>
              {(spec.choices ?? []).map((option) => (
                <label key={option} className={styles.choice}>
                  <input
                    type="checkbox"
                    value={option}
                    checked={checked.includes(option)}
                    onChange={(e) =>
                      setChecked((prev) =>
                        e.target.checked
                          ? [...prev, option]
                          : prev.filter((entry) => entry !== option),
                      )
                    }
                    disabled={disabled}
                  />
                  <span>{choiceLabel(option, judgment)}</span>
                </label>
              ))}
            </div>
          )}

          {spec.type === 'boolean' && (
            <label className={styles.choice}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={toggled}
                checked={toggled}
                onChange={(e) => setToggled(e.target.checked)}
                disabled={disabled}
              />
              <span>{toggled ? 'Yes' : 'No'}</span>
            </label>
          )}

          <div className={styles.actions}>
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={disabled}>
              Submit
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function JudgmentPackageView({ judgment }: { readonly judgment: JudgmentPackage }): JSX.Element {
  return (
    <div className={styles.judgment}>
      <div>
        <div className={styles.judgmentHeading}>
          Experiment judgment — iteration {judgment.iteration} of {judgment.maxIterations}
        </div>
        <div className={styles.judgmentBlock}>{judgment.hypothesis}</div>
      </div>

      {judgment.rubricSummary && (
        <div>
          <div className={styles.judgmentHeading}>Rubric</div>
          <div className={styles.judgmentBlock}>{judgment.rubricSummary}</div>
        </div>
      )}

      {judgment.killCriteria.length > 0 && (
        <div>
          <div className={styles.judgmentHeading}>Kill criteria</div>
          <ul className={styles.judgmentList}>
            {judgment.killCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      )}

      {judgment.survivors.length > 0 && (
        <div>
          <div className={styles.judgmentHeading}>Survivors</div>
          <div className={styles.choices}>
            {judgment.survivors.map((survivor) => (
              <div key={survivor.candidateId} className={styles.survivor}>
                <div className={styles.survivorTitle}>
                  {survivor.title}
                  <Badge tone="accent">score {survivor.weightedScore.toFixed(2)}</Badge>
                </div>
                <div className={styles.survivorSummary}>{survivor.summary}</div>
                {survivor.keyEvidence.length > 0 && (
                  <ul className={styles.survivorEvidence}>
                    {survivor.keyEvidence.map((evidence) => (
                      <li key={evidence}>{evidence}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className={styles.judgmentHeading}>Recommendation</div>
        <div className={styles.judgmentBlock}>{judgment.recommendation}</div>
      </div>

      {judgment.risks.length > 0 && (
        <div>
          <div className={styles.judgmentHeading}>Risks</div>
          <ul className={styles.judgmentList}>
            {judgment.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
