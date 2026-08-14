/**
 * Secret storage contract. Values live in OS credential storage (or an
 * encrypted fallback); domain and orchestration code passes SecretRefs, never
 * raw values. Raw values are resolved only at the point of side-channel use.
 */

export interface SecretRef {
  /** Namespaced secret name, e.g. `provider/anthropic/api-key`. */
  readonly name: string
}

export interface SecretMetadata {
  readonly name: string
  readonly createdAt?: Date
  readonly updatedAt?: Date
}

export interface SecretProvider {
  readonly id: string
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  /** Lists names/metadata only — never values. */
  list(prefix?: string): Promise<readonly SecretMetadata[]>
}
