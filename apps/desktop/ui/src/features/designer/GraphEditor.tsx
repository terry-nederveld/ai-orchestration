/**
 * Editor over ONE canonical workflow graph document (ADR-0026): the canvas
 * and the YAML editor are two projections of the same document — a YAML
 * edit re-renders the canvas, an inspector edit rewrites the YAML, and
 * neither format is privileged. Saving validates through the daemon's
 * shared `validateGraph` endpoint and PUTs the document (content-addressed:
 * an unchanged save mints no new version).
 */

import { useEffect, useRef, useState } from 'react'
import YAML from 'yaml'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Tabs } from '../../components/Tabs'
import styles from './designer.module.css'
import { GraphCanvas, type GraphSelection } from './GraphCanvas'
import { Inspector } from './Inspector'
import type { GraphIssue, WorkflowGraphDoc } from './types'

const YAML_PARSE_DEBOUNCE_MS = 300

export interface GraphEditorProps {
  readonly name: string
  readonly initialDocument: WorkflowGraphDoc
  readonly onValidate: (doc: WorkflowGraphDoc) => Promise<readonly GraphIssue[]>
  readonly onSave: (doc: WorkflowGraphDoc) => Promise<{ readonly version: number }>
}

function isGraphShaped(value: unknown): value is WorkflowGraphDoc {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).nodes) &&
    Array.isArray((value as Record<string, unknown>).transitions)
  )
}

export function GraphEditor({
  name,
  initialDocument,
  onValidate,
  onSave,
}: GraphEditorProps): JSX.Element {
  const [doc, setDoc] = useState<WorkflowGraphDoc>(initialDocument)
  const [yamlText, setYamlText] = useState(() => YAML.stringify(initialDocument))
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [tab, setTab] = useState('canvas')
  const [selection, setSelection] = useState<GraphSelection | null>(null)
  const [issues, setIssues] = useState<readonly GraphIssue[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  const parseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(parseTimer.current), [])

  /** A document edit from the canvas/inspector side: re-project the YAML. */
  const changeDocument = (next: WorkflowGraphDoc) => {
    setDoc(next)
    setYamlText(YAML.stringify(next))
    setYamlError(null)
    setSaveResult(null)
  }

  /** A YAML edit: debounce-parse and re-project the canvas. */
  const changeYaml = (text: string) => {
    setYamlText(text)
    setSaveResult(null)
    clearTimeout(parseTimer.current)
    parseTimer.current = setTimeout(() => {
      try {
        const parsed: unknown = YAML.parse(text)
        if (!isGraphShaped(parsed)) {
          setYamlError('document must be a mapping with nodes and transitions lists')
          return
        }
        setYamlError(null)
        setDoc(parsed)
      } catch (error) {
        setYamlError(error instanceof Error ? error.message : String(error))
      }
    }, YAML_PARSE_DEBOUNCE_MS)
  }

  const save = async () => {
    setSaving(true)
    setIssues(null)
    setSaveResult(null)
    try {
      const found = await onValidate(doc)
      if (found.length > 0) {
        setIssues(found)
        return
      }
      const saved = await onSave(doc)
      setIssues([])
      setSaveResult(`Saved as version ${saved.version}. Enabled runs are untouched.`)
    } catch (error) {
      setSaveResult(null)
      setIssues([
        { path: '(save)', message: error instanceof Error ? error.message : String(error) },
      ])
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <Tabs
          items={[
            { key: 'canvas', label: 'Canvas' },
            { key: 'yaml', label: 'YAML' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <Button
          variant="primary"
          loading={saving}
          disabled={yamlError !== null}
          onClick={() => void save()}
        >
          Save
        </Button>
        <span className={styles.toolbarNote}>
          Saving mints a new immutable version of '{name}'; in-flight runs keep theirs.
        </span>
      </div>

      {tab === 'canvas' ? (
        <div className={selection ? styles.editorColumns : styles.editorSingle}>
          <GraphCanvas graph={doc} selection={selection} onSelect={setSelection} />
          {selection && <Inspector doc={doc} selection={selection} onChange={changeDocument} />}
        </div>
      ) : (
        <div>
          <textarea
            className={styles.yamlArea}
            value={yamlText}
            onChange={(event) => changeYaml(event.target.value)}
            spellCheck={false}
            aria-label="workflow YAML"
          />
          {yamlError && <div className={styles.errorText}>YAML: {yamlError}</div>}
        </div>
      )}

      {issues && issues.length > 0 && (
        <div className={styles.issueList} role="alert">
          <Badge tone="danger">save blocked by validation</Badge>
          {issues.map((issue) => (
            <div key={`${issue.path}:${issue.message}`} className={styles.issue}>
              {issue.path}: {issue.message}
            </div>
          ))}
        </div>
      )}
      {saveResult && <div className={styles.okText}>{saveResult}</div>}
    </div>
  )
}
