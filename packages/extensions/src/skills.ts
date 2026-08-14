/**
 * Skills: markdown files with YAML frontmatter that get injected into an
 * agent's prompt. `loadSkillsFromDirectories` scans directories in order;
 * when two skills share a name, the one from a later directory wins, and
 * directories are expected to be passed low-to-high precedence
 * (global < user < project < workflow < agent).
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export type SkillScope = 'global' | 'user' | 'project' | 'workflow' | 'agent'

export interface Skill {
  readonly name: string
  readonly description: string
  readonly scope: SkillScope
  readonly body: string
  readonly path: string
}

/** Precedence order, lowest to highest; later entries override earlier ones. */
const SCOPE_PRECEDENCE: readonly SkillScope[] = ['global', 'user', 'project', 'workflow', 'agent']

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function scopeRank(scope: SkillScope): number {
  const rank = SCOPE_PRECEDENCE.indexOf(scope)
  return rank === -1 ? 0 : rank
}

function parseSkillFile(source: string, filePath: string): Skill | undefined {
  const match = FRONTMATTER_PATTERN.exec(source)
  if (!match) return undefined

  const [, frontmatterText, body] = match
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(frontmatterText ?? '')
  } catch {
    return undefined
  }

  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined
  const { name, description, scope } = frontmatter as Record<string, unknown>
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof description !== 'string' || description.length === 0) return undefined
  if (typeof scope !== 'string' || !SCOPE_PRECEDENCE.includes(scope as SkillScope)) return undefined

  return {
    name,
    description,
    scope: scope as SkillScope,
    body: (body ?? '').trim(),
    path: filePath,
  }
}

async function loadSkillsFromDirectory(dir: string): Promise<Skill[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)
    let source: string
    try {
      source = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    const skill = parseSkillFile(source, filePath)
    if (skill !== undefined) skills.push(skill)
  }
  return skills
}

/**
 * Loads skills from directories in the given order. Directories should be
 * passed low-to-high precedence; a skill name found in a later directory
 * replaces one found in an earlier one, regardless of each skill's declared
 * scope.
 */
export async function loadSkillsFromDirectories(dirs: readonly string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>()
  for (const dir of dirs) {
    for (const skill of await loadSkillsFromDirectory(dir)) {
      byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))
}

export interface SelectSkillsOptions {
  /** Case-insensitive substring match against name or description. */
  readonly query?: readonly string[]
  readonly scope?: readonly SkillScope[]
}

export function selectSkills(skills: readonly Skill[], options: SelectSkillsOptions = {}): Skill[] {
  const query = options.query?.map((q) => q.toLowerCase())
  const scopes = options.scope !== undefined ? new Set(options.scope) : undefined

  return skills.filter((skill) => {
    if (scopes !== undefined && !scopes.has(skill.scope)) return false
    if (query !== undefined && query.length > 0) {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase()
      if (!query.some((term) => haystack.includes(term))) return false
    }
    return true
  })
}

/** Renders a compact prompt block: name + body per skill, in list order. */
export function renderSkillsPrompt(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  return skills.map((skill) => `## ${skill.name}\n\n${skill.body}`).join('\n\n')
}
