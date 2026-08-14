import { useState } from 'react'
import { useParams } from 'react-router'
import { useConnection } from '../../api/connection'
import type { WorkflowDefinition, WorkflowStep, WorkflowValidationResult } from '../../api/types'
import { useApiQuery } from '../../api/useApiQuery'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import styles from './WorkflowDetail.module.css'

const STEP_ICON: Record<WorkflowStep['kind'], string> = {
  agent: 'A',
  command: '$',
  action: '⚡',
  approval: '✓',
}

/** Topological order for display; falls back to declared order on a cycle
 * (the daemon rejects cyclic workflows before they ever reach the client). */
function orderSteps(steps: readonly WorkflowStep[]): readonly WorkflowStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const visited = new Set<string>()
  const ordered: WorkflowStep[] = []
  const visit = (step: WorkflowStep) => {
    if (visited.has(step.id)) return
    visited.add(step.id)
    for (const dep of step.dependsOn ?? []) {
      const depStep = byId.get(dep)
      if (depStep) visit(depStep)
    }
    ordered.push(step)
  }
  for (const step of steps) visit(step)
  return ordered
}

export function WorkflowDetail(): JSX.Element {
  const { name } = useParams<{ name: string }>()
  const query = useApiQuery((client) => client.listWorkflows(), [])
  const workflow = query.data?.find((w) => w.name === name)

  if (query.loading) return <Spinner />
  if (query.error) return <EmptyState icon="!" title="Couldn't load workflow" hint={query.error} />
  if (!workflow)
    return <EmptyState icon="?" title="Workflow not found" hint={`No workflow named '${name}'`} />

  return (
    <div>
      <WorkflowHeader workflow={workflow} />
      <div className={styles.columns}>
        <Card title="Steps">
          <div className={styles.stepList}>
            {orderSteps(workflow.steps).map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        </Card>
        <ValidatePanel />
      </div>
    </div>
  )
}

function WorkflowHeader({ workflow }: { readonly workflow: WorkflowDefinition }): JSX.Element {
  return (
    <div className={styles.header}>
      <div className={styles.name}>{workflow.name}</div>
      {workflow.description && <div className={styles.description}>{workflow.description}</div>}
      <div className={styles.metaRow}>
        {workflow.trigger?.states?.map((s) => (
          <Badge key={`s-${s}`}>on {s}</Badge>
        ))}
        {workflow.trigger?.labels?.map((l) => (
          <Badge key={`l-${l}`} tone="accent">
            label:{l}
          </Badge>
        ))}
        {workflow.workspace && (
          <Badge tone="neutral">workspace: {workflow.workspace.strategy}</Badge>
        )}
        {workflow.budget && <Badge tone="neutral">budget: {workflow.budget}</Badge>}
      </div>
    </div>
  )
}

function StepCard({ step }: { readonly step: WorkflowStep }): JSX.Element {
  return (
    <div className={styles.step}>
      <div className={styles.stepTop}>
        <span className={styles.stepIcon}>{STEP_ICON[step.kind]}</span>
        <span className={styles.stepId}>{step.id}</span>
        <Badge tone="neutral">{step.kind}</Badge>
      </div>
      {step.kind === 'agent' && <div className={styles.stepGoal}>{step.goal}</div>}
      {step.kind === 'command' && <div className={styles.stepGoal}>{step.command}</div>}
      {step.kind === 'action' && <div className={styles.stepGoal}>{step.action}</div>}
      {step.kind === 'approval' && <div className={styles.stepGoal}>{step.description}</div>}
      <div className={styles.stepMeta}>
        {step.dependsOn && step.dependsOn.length > 0 && (
          <span className={styles.depends}>depends_on: {step.dependsOn.join(', ')}</span>
        )}
        {step.when && <span className={styles.depends}>when: {step.when}</span>}
        {step.continueOnFailure && <span>continues on failure</span>}
      </div>
    </div>
  )
}

function ValidatePanel(): JSX.Element {
  const { client } = useConnection()
  const [source, setSource] = useState('')
  const [result, setResult] = useState<WorkflowValidationResult | null>(null)
  const [checking, setChecking] = useState(false)

  const runValidation = async () => {
    if (!client || !source.trim()) return
    setChecking(true)
    try {
      setResult(await client.validateWorkflow(source))
    } catch (err) {
      setResult({ valid: false, issues: [err instanceof Error ? err.message : String(err)] })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Card
      title="Validate workflow YAML"
      subtitle="Paste a workflow document to check it before saving"
    >
      <textarea
        className={styles.textarea}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder={'name: my-workflow\nsteps:\n  - id: plan\n    agent: planner\n    goal: ...'}
        spellCheck={false}
      />
      <div style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="primary" loading={checking} onClick={() => void runValidation()}>
          Validate
        </Button>
      </div>
      {result && (
        <div className={styles.issues}>
          {result.valid ? (
            <div className={styles.valid}>Valid workflow definition.</div>
          ) : (
            result.issues.map((issue) => (
              <div key={issue} className={styles.issue}>
                {issue}
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  )
}
