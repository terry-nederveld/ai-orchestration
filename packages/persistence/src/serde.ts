/**
 * Small serialization helpers shared by the SQLite repositories. Dates are
 * stored as ISO-8601 strings and rehydrated to `Date` instances on read;
 * everything else round-trips through JSON.
 */

export function toJson(value: unknown): string {
  return JSON.stringify(value)
}

export function fromJson<T>(text: string): T {
  return JSON.parse(text) as T
}

export function fromJsonOrUndefined<T>(text: string | null | undefined): T | undefined {
  return text == null ? undefined : (JSON.parse(text) as T)
}
