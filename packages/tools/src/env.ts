/**
 * Environment hygiene for spawned workspace commands. The daemon's own
 * environment may hold operator credentials (API keys, cloud tokens);
 * spawned commands receive only an explicit allowlist plus whatever the
 * caller deliberately passes.
 */

const DEFAULT_ALLOWED = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const

const ALLOWED_PREFIXES = ['LC_', 'XDG_'] as const

/**
 * Build a minimal child environment from the daemon's own: allowlisted
 * variables only, then the caller's explicit additions.
 */
export function sandboxedEnv(
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of DEFAULT_ALLOWED) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }
  return { ...env, ...extra }
}
