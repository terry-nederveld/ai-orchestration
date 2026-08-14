/**
 * Zod schema for `ExtensionManifest` (see `@overture/core`'s `extensions.ts`).
 * Validation is a single pass (`safeParse`) so a manifest with multiple
 * problems reports every one of them, not just the first.
 */

import type { ExtensionManifest } from '@overture/core'
import { HookPoint, PermissionCapability } from '@overture/core'
import { z } from 'zod'

/** Reverse-DNS identifier, e.g. `com.example.security-scan`. */
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/i

/** Permissive semver: `MAJOR.MINOR.PATCH` with optional pre-release/build. */
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

const hookPointValues = Object.values(HookPoint) as [HookPoint, ...HookPoint[]]
const permissionCapabilityValues = Object.values(PermissionCapability) as [
  PermissionCapability,
  ...PermissionCapability[],
]

export const extensionManifestSchema = z
  .object({
    id: z
      .string()
      .regex(EXTENSION_ID_PATTERN, 'must be reverse-DNS style, e.g. com.example.security-scan'),
    name: z.string().min(1),
    version: z.string().regex(SEMVER_PATTERN, 'must be a semantic version, e.g. 1.0.0'),
    description: z.string().min(1).optional(),
    provides: z
      .object({
        tools: z.array(z.string().min(1)).optional(),
        workflowActions: z.array(z.string().min(1)).optional(),
        hooks: z.array(z.enum(hookPointValues)).optional(),
      })
      .strict(),
    permissions: z.array(z.enum(permissionCapabilityValues)),
  })
  .strict()

export type ExtensionManifestInput = z.infer<typeof extensionManifestSchema>

export interface ExtensionManifestIssue {
  readonly path: string
  readonly message: string
}

export class ExtensionManifestError extends Error {
  readonly issues: readonly ExtensionManifestIssue[]

  constructor(issues: readonly ExtensionManifestIssue[]) {
    super(ExtensionManifestError.formatMessage(issues))
    this.name = 'ExtensionManifestError'
    this.issues = issues
  }

  private static formatMessage(issues: readonly ExtensionManifestIssue[]): string {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`)
    return `extension manifest validation failed with ${issues.length} issue(s):\n${lines.join('\n')}`
  }
}

function formatPath(path: readonly (string | number | symbol)[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      const key = String(segment)
      out += out ? `.${key}` : key
    }
  }
  return out || '(root)'
}

/** Parses and validates a manifest. Throws {@link ExtensionManifestError} listing every problem found. */
export function parseExtensionManifest(json: unknown): ExtensionManifest {
  const result = extensionManifestSchema.safeParse(json)
  if (!result.success) {
    throw new ExtensionManifestError(
      result.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    )
  }
  const raw = result.data
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    provides: {
      ...(raw.provides.tools !== undefined ? { tools: raw.provides.tools } : {}),
      ...(raw.provides.workflowActions !== undefined
        ? { workflowActions: raw.provides.workflowActions }
        : {}),
      ...(raw.provides.hooks !== undefined ? { hooks: raw.provides.hooks } : {}),
    },
    permissions: raw.permissions,
  }
}

/** JSON Schema representation of the manifest format, for editor tooling / docs. */
export const extensionManifestJsonSchema = z.toJSONSchema(extensionManifestSchema)
