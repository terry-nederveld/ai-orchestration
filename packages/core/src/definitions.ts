/**
 * Versioned definitions and immutable run snapshots (ADR-0018).
 *
 * Every reusable definition — workflows, sub-workflows, gate sets, rubrics,
 * agent profiles, templates, mapping rule sets — is stored as an immutable
 * content-addressed version. Runs pin a ResolvedSnapshot at start and
 * execute exclusively against it.
 */

export const DefinitionKind = {
  Workflow: 'workflow',
  GateSet: 'gate-set',
  Rubric: 'rubric',
  AgentProfile: 'agent-profile',
  Experiment: 'experiment',
  Template: 'template',
  MappingRuleSet: 'mapping-rule-set',
  Lane: 'lane',
  Schedule: 'schedule',
} as const

export type DefinitionKind = (typeof DefinitionKind)[keyof typeof DefinitionKind]

export type DefinitionLifecycle = 'draft' | 'enabled' | 'disabled'

export interface DefinitionVersion {
  readonly kind: DefinitionKind
  readonly name: string
  /** Monotonically increasing per (kind, name). */
  readonly version: number
  /** SHA-256 of the canonicalized document; deduplicates saves. */
  readonly contentHash: string
  /** Canonical parsed document (JSON-serializable). */
  readonly document: Readonly<Record<string, unknown>>
  readonly createdAt: Date
}

export interface DefinitionStatus {
  readonly kind: DefinitionKind
  readonly name: string
  readonly lifecycle: DefinitionLifecycle
  readonly latestVersion: number
}

/**
 * The complete, self-contained resolution of everything a run executes:
 * exact definition documents keyed by `kind:name@version`. Ticks, resumes,
 * and Evaluate read from here only.
 */
export interface ResolvedSnapshot {
  readonly id: string
  /** Root workflow reference. */
  readonly root: { readonly name: string; readonly version: number }
  readonly definitions: ReadonlyArray<DefinitionVersion>
  readonly createdAt: Date
}

export function snapshotKey(kind: DefinitionKind, name: string, version: number): string {
  return `${kind}:${name}@${version}`
}

export function findInSnapshot(
  snapshot: ResolvedSnapshot,
  kind: DefinitionKind,
  name: string,
  version?: number,
): DefinitionVersion | undefined {
  if (version !== undefined) {
    return snapshot.definitions.find(
      (definition) =>
        definition.kind === kind && definition.name === name && definition.version === version,
    )
  }
  // Absent version means "the version resolved at snapshot time" — a
  // snapshot contains at most one version per (kind, name).
  return snapshot.definitions.find(
    (definition) => definition.kind === kind && definition.name === name,
  )
}

/** Store port for versioned definitions. */
export interface DefinitionStore {
  /**
   * Save a document; returns the existing version when contentHash is
   * unchanged, otherwise mints version latest+1.
   */
  save(
    kind: DefinitionKind,
    name: string,
    document: Readonly<Record<string, unknown>>,
  ): Promise<DefinitionVersion>
  get(kind: DefinitionKind, name: string, version?: number): Promise<DefinitionVersion | undefined>
  list(kind: DefinitionKind): Promise<readonly DefinitionStatus[]>
  listVersions(kind: DefinitionKind, name: string): Promise<readonly DefinitionVersion[]>
  setLifecycle(kind: DefinitionKind, name: string, lifecycle: DefinitionLifecycle): Promise<void>
  getLifecycle(kind: DefinitionKind, name: string): Promise<DefinitionLifecycle>
  saveSnapshot(snapshot: ResolvedSnapshot): Promise<void>
  getSnapshot(id: string): Promise<ResolvedSnapshot | undefined>
}

/** Canonical JSON: stable key order, no whitespace variance. */
export function canonicalizeDocument(document: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(sortValue(document))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key])
    }
    return sorted
  }
  return value
}
