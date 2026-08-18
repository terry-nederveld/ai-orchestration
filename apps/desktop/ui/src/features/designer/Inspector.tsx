/**
 * Inspector for the selected node or transition: full config as pretty
 * JSON plus field editing that writes back into the canonical document
 * (so the canvas and the YAML view update from the same edit).
 */

import { useState } from 'react'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { CodeBlock } from '../../components/CodeBlock'
import styles from './designer.module.css'
import {
  findNode,
  findTransition,
  nodeKindIcon,
  replaceNodeConfig,
  updateTransitionFields,
} from './document'
import type { GraphSelection } from './GraphCanvas'
import type { GraphNodeDoc, GraphTransitionDoc, WorkflowGraphDoc } from './types'

export interface InspectorProps {
  readonly doc: WorkflowGraphDoc
  readonly selection: GraphSelection
  readonly onChange: (doc: WorkflowGraphDoc) => void
}

export function Inspector({ doc, selection, onChange }: InspectorProps): JSX.Element {
  if (selection.type === 'node') {
    const node = findNode(doc, selection.id)
    if (!node) return <div className={styles.inspector}>Node no longer exists.</div>
    return <NodeInspector key={selection.id} doc={doc} node={node} onChange={onChange} />
  }
  const transition = findTransition(doc, selection.id)
  if (!transition) return <div className={styles.inspector}>Transition no longer exists.</div>
  return (
    <TransitionInspector key={selection.id} doc={doc} transition={transition} onChange={onChange} />
  )
}

function NodeInspector({
  doc,
  node,
  onChange,
}: {
  readonly doc: WorkflowGraphDoc
  readonly node: GraphNodeDoc
  readonly onChange: (doc: WorkflowGraphDoc) => void
}): JSX.Element {
  const [configText, setConfigText] = useState(() => JSON.stringify(node.config, null, 2))
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('config must be a JSON object')
        return
      }
      if (typeof parsed['kind'] !== 'string') {
        setError('config must declare a string kind')
        return
      }
      setError(null)
      onChange(replaceNodeConfig(doc, node.id, parsed as GraphNodeDoc['config']))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <aside className={styles.inspector} aria-label={`inspector for ${node.id}`}>
      <div className={styles.inspectorTitle}>
        <span>{nodeKindIcon(node.config.kind)}</span>
        <span>{node.id}</span>
        <Badge tone="accent">{node.config.kind}</Badge>
      </div>
      <div>
        <div className={styles.fieldLabel}>config (JSON, editable)</div>
        <textarea
          className={styles.jsonArea}
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
          spellCheck={false}
          aria-label="node config JSON"
        />
        {error && <div className={styles.errorText}>{error}</div>}
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Button size="sm" variant="primary" onClick={apply}>
            Apply to document
          </Button>
        </div>
      </div>
      <div>
        <div className={styles.fieldLabel}>full node</div>
        <CodeBlock maxHeight={240}>{JSON.stringify(node, null, 2)}</CodeBlock>
      </div>
    </aside>
  )
}

function TransitionInspector({
  doc,
  transition,
  onChange,
}: {
  readonly doc: WorkflowGraphDoc
  readonly transition: GraphTransitionDoc
  readonly onChange: (doc: WorkflowGraphDoc) => void
}): JSX.Element {
  const [condition, setCondition] = useState(transition.condition ?? '')
  const [loopBound, setLoopBound] = useState(
    transition.loopBound !== undefined ? String(transition.loopBound) : '',
  )
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    const trimmed = loopBound.trim()
    let bound: number | undefined
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError('loopBound must be an integer >= 1')
        return
      }
      bound = parsed
    }
    setError(null)
    onChange(
      updateTransitionFields(doc, transition.id, {
        condition: condition.trim(),
        ...(bound !== undefined ? { loopBound: bound } : {}),
      }),
    )
  }

  return (
    <aside className={styles.inspector} aria-label={`inspector for ${transition.id}`}>
      <div className={styles.inspectorTitle}>
        <span>{transition.id}</span>
        <Badge tone="neutral">
          {transition.from} → {transition.to}
        </Badge>
      </div>
      <div>
        <div className={styles.fieldLabel}>condition (empty = unconditional)</div>
        <input
          className={styles.textInput}
          value={condition}
          onChange={(event) => setCondition(event.target.value)}
          spellCheck={false}
          aria-label="transition condition"
        />
      </div>
      <div>
        <div className={styles.fieldLabel}>loopBound</div>
        <input
          className={styles.textInput}
          value={loopBound}
          onChange={(event) => setLoopBound(event.target.value)}
          spellCheck={false}
          aria-label="transition loop bound"
        />
      </div>
      {error && <div className={styles.errorText}>{error}</div>}
      <div>
        <Button size="sm" variant="primary" onClick={apply}>
          Apply to document
        </Button>
      </div>
      <div>
        <div className={styles.fieldLabel}>full transition</div>
        <CodeBlock maxHeight={200}>{JSON.stringify(transition, null, 2)}</CodeBlock>
      </div>
    </aside>
  )
}
