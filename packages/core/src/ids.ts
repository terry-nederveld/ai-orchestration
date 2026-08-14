/**
 * Branded identifier types and foundational ports used across the domain.
 *
 * All time and identifier generation flows through ports so domain logic and
 * the orchestration kernel stay deterministic under test.
 */

declare const brand: unique symbol

/** Nominal (branded) string identifier. */
export type Id<Brand extends string> = string & { readonly [brand]: Brand }

export type RunId = Id<'run'>
export type SessionId = Id<'session'>
export type WorkItemId = Id<'work-item'>
export type WorkspaceId = Id<'workspace'>
export type ArtifactId = Id<'artifact'>
export type EventId = Id<'event'>
export type StepId = Id<'step'>
export type ProjectId = Id<'project'>

export const asId = <Brand extends string>(value: string): Id<Brand> => value as Id<Brand>

/** Source of current time. Inject a fixed clock in tests. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

/** Source of unique identifiers. Inject a sequential generator in tests. */
export interface IdGenerator {
  next(prefix: string): string
}

/** Structured logger port. Implementations must never log secret values. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}
