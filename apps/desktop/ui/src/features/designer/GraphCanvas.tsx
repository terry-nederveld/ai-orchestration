/**
 * Read-only-first SVG rendering of the canonical workflow graph: layered
 * DAG with loops drawn as dashed side curves (ADR-0026 — the canvas is a
 * projection of the document, never a second format). Clicking a node or
 * transition selects it for the inspector.
 */

import { useMemo } from 'react'
import styles from './designer.module.css'
import { nodeKindIcon, nodeSummary, transitionLabel, truncate } from './document'
import { layoutGraph } from './layout'
import type { WorkflowGraphDoc } from './types'

export type GraphSelection =
  | { readonly type: 'node'; readonly id: string }
  | { readonly type: 'transition'; readonly id: string }

export interface GraphCanvasProps {
  readonly graph: WorkflowGraphDoc
  readonly selection: GraphSelection | null
  readonly onSelect: (selection: GraphSelection | null) => void
}

export function GraphCanvas({ graph, selection, onSelect }: GraphCanvasProps): JSX.Element {
  const layout = useMemo(() => layoutGraph(graph), [graph])

  return (
    <div className={styles.canvasWrap}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: background click clears
          the selection; keyboard users deselect via the focusable elements. */}
      <svg
        className={styles.canvasSvg}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`workflow graph ${graph.name}`}
        onClick={() => onSelect(null)}
      >
        <defs>
          <marker
            id="designer-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-border-strong)" />
          </marker>
          <marker
            id="designer-arrow-back"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-warning)" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const selected = selection?.type === 'transition' && selection.id === edge.transition.id
          const label = transitionLabel(edge.transition)
          const full = [
            `${edge.transition.from} → ${edge.transition.to}`,
            edge.transition.condition ? `condition: ${edge.transition.condition}` : 'unconditional',
            edge.transition.loopBound !== undefined
              ? `loopBound: ${edge.transition.loopBound}`
              : undefined,
          ]
            .filter(Boolean)
            .join('\n')
          return (
            // biome-ignore lint/a11y/useSemanticElements: HTML buttons cannot exist inside SVG
            <g
              key={edge.transition.id}
              role="button"
              tabIndex={0}
              aria-label={`transition ${edge.transition.id}`}
              className={selected ? styles.edgeSelected : undefined}
              onClick={(event) => {
                event.stopPropagation()
                onSelect({ type: 'transition', id: edge.transition.id })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSelect({ type: 'transition', id: edge.transition.id })
              }}
              data-testid={`edge-${edge.transition.id}`}
            >
              <title>{full}</title>
              <path className={styles.edgeHit} d={edge.path} />
              <path
                className={[styles.edgePath, edge.kind !== 'forward' ? styles.edgeBack : '']
                  .filter(Boolean)
                  .join(' ')}
                d={edge.path}
                markerEnd={
                  edge.kind === 'forward' ? 'url(#designer-arrow)' : 'url(#designer-arrow-back)'
                }
              />
              {label && (
                <text
                  className={styles.edgeLabel}
                  x={edge.labelX}
                  y={edge.labelY - 5}
                  textAnchor="middle"
                >
                  {label}
                </text>
              )}
            </g>
          )
        })}

        {layout.nodes.map((placed) => {
          const selected = selection?.type === 'node' && selection.id === placed.id
          const summary = nodeSummary(placed.node)
          return (
            // biome-ignore lint/a11y/useSemanticElements: HTML buttons cannot exist inside SVG
            <g
              key={placed.id}
              role="button"
              tabIndex={0}
              aria-label={`node ${placed.id}`}
              className={[
                styles.node,
                selected ? styles.nodeSelected : '',
                placed.id === graph.entry ? styles.nodeEntry : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={(event) => {
                event.stopPropagation()
                onSelect({ type: 'node', id: placed.id })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSelect({ type: 'node', id: placed.id })
              }}
            >
              <title>{`${placed.id} (${placed.node.config.kind})`}</title>
              <rect
                className={styles.nodeRect}
                x={placed.x}
                y={placed.y}
                width={placed.width}
                height={placed.height}
                rx={8}
              />
              <text className={styles.nodeIcon} x={placed.x + 10} y={placed.y + 20}>
                {nodeKindIcon(placed.node.config.kind)}
              </text>
              <text className={styles.nodeId} x={placed.x + 26} y={placed.y + 20}>
                {truncate(placed.id, 18)}
              </text>
              <text className={styles.nodeKind} x={placed.x + 10} y={placed.y + 34}>
                {placed.node.config.kind}
              </text>
              <text className={styles.nodeSummary} x={placed.x + 10} y={placed.y + 48}>
                {truncate(summary, 28)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
