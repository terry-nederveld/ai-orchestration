/**
 * Designer-facing views of the canonical workflow graph document
 * (ADR-0017/ADR-0026), the definition store (ADR-0018), and the Evaluate
 * report. These mirror `@overture/core` / `@overture/orchestrator` shapes;
 * the daemon's JSON API is the contract.
 */

export type DefinitionLifecycle = 'draft' | 'enabled' | 'disabled'

export interface WorkflowDefinitionStatus {
  readonly kind: string
  readonly name: string
  readonly lifecycle: DefinitionLifecycle
  readonly latestVersion: number
}

export interface DefinitionVersionInfo {
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
}

export interface WorkflowDefinitionDetail {
  readonly kind: string
  readonly name: string
  readonly lifecycle: DefinitionLifecycle
  readonly latestVersion: number
  readonly definition: DefinitionVersionInfo & { readonly document: WorkflowGraphDoc }
  readonly versions: readonly DefinitionVersionInfo[]
}

export interface GraphIssue {
  readonly path: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Canonical graph document. `config` stays an open record so the designer
// renders (and round-trips) every field even for constructs it has no
// bespoke editor for — partial rendering would reintroduce format drift.
// ---------------------------------------------------------------------------

export interface GraphNodeDoc {
  readonly id: string
  readonly config: { readonly kind: string } & Readonly<Record<string, unknown>>
  readonly join?: { readonly mode: 'any' | 'all' | 'min'; readonly n?: number }
  readonly guards?: readonly string[]
  readonly onEnter?: Readonly<Record<string, unknown>>
  readonly onExit?: Readonly<Record<string, unknown>>
  readonly retry?: Readonly<Record<string, unknown>>
}

export interface GraphTransitionDoc {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly condition?: string
  readonly loopBound?: number
  readonly effects?: Readonly<Record<string, unknown>>
}

export interface WorkflowGraphDoc {
  readonly name: string
  readonly description?: string
  readonly entry: string
  readonly nodes: readonly GraphNodeDoc[]
  readonly transitions: readonly GraphTransitionDoc[]
  /** Extra canonical fields (projection, trigger, workspace, …) pass through. */
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Evaluate request/report (POST /api/evaluate).
// ---------------------------------------------------------------------------

export interface EvaluateRequestBody {
  readonly workflowName: string
  readonly version?: number
  readonly itemExternalId?: string
  readonly item?: Readonly<Record<string, unknown>>
  readonly variables?: Readonly<Record<string, unknown>>
  readonly hypotheticalOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type GatePreviewOutcome = 'pass' | 'fail' | 'indeterminate'

export interface EvaluationReportView {
  readonly workflow: {
    readonly name: string
    readonly version: number
    readonly lifecycle: DefinitionLifecycle
    readonly validationIssues: readonly GraphIssue[]
  }
  readonly matching: { readonly selection: string; readonly rationale: string }
  readonly repositories: {
    readonly resolved: ReadonlyArray<{
      readonly repository: { readonly locator: string }
      readonly role: string
      readonly resolvedBy: string
    }>
    readonly rulesEvaluated: ReadonlyArray<{
      readonly ruleId: string
      readonly priority: number
      readonly matched: boolean
      readonly onConflict: string
    }>
  }
  readonly instructions: ReadonlyArray<{
    readonly providerId: string
    readonly source: string
    readonly scope: string
    readonly path: string
    readonly precedence: number
  }>
  readonly contextPreview: {
    readonly fragments: ReadonlyArray<{
      readonly resolverId: string
      readonly kind: string
      readonly title: string
      readonly priority: number
      readonly provenance: string
      readonly chars: number
    }>
    readonly excluded: ReadonlyArray<{ readonly title: string; readonly reason: string }>
    readonly totalChars: number
  }
  readonly gates: ReadonlyArray<{
    readonly nodeId: string
    readonly gateSetName: string
    readonly gateSetVersion: number
    readonly gates: ReadonlyArray<{
      readonly gateId: string
      readonly kind: string
      readonly required: boolean
      readonly outcome: GatePreviewOutcome
      readonly reason: string
    }>
  }>
  readonly path: { readonly nodes: readonly string[]; readonly stopReason: string }
  readonly profiles: ReadonlyArray<{
    readonly nodeId: string
    readonly profileName: string
    readonly primaryExecutor?: string
    readonly primaryAvailable?: boolean
    readonly fallbackChain: ReadonlyArray<{
      readonly executor: string
      readonly available: boolean
    }>
    readonly satisfiable: boolean
    readonly error?: string
  }>
  readonly expectedSideEffects: ReadonlyArray<{
    readonly nodeId: string
    readonly kind: string
    readonly description: string
    readonly details?: Readonly<Record<string, unknown>>
  }>
  readonly blockers: ReadonlyArray<{ readonly kind: string; readonly message: string }>
}
