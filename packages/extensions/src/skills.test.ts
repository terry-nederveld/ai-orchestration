import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSkillsFromDirectories, renderSkillsPrompt, selectSkills } from './skills.js'

function skillMarkdown(name: string, description: string, scope: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nscope: ${scope}\n---\n${body}\n`
}

describe('skills', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(async () => {
    globalDir = await mkdtemp(path.join(tmpdir(), 'skills-global-'))
    projectDir = await mkdtemp(path.join(tmpdir(), 'skills-project-'))
  })

  afterEach(async () => {
    await rm(globalDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  it('loads skills from a directory of markdown files', async () => {
    await writeFile(
      path.join(globalDir, 'greet.md'),
      skillMarkdown('greet', 'Greets the user', 'global', 'Say hello warmly.'),
    )
    await writeFile(path.join(globalDir, 'README.txt'), 'not a skill')

    const skills = await loadSkillsFromDirectories([globalDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'greet',
      description: 'Greets the user',
      scope: 'global',
      body: 'Say hello warmly.',
    })
  })

  it('later directories override earlier ones for duplicate names', async () => {
    await writeFile(
      path.join(globalDir, 'greet.md'),
      skillMarkdown('greet', 'Global greet', 'global', 'Global body.'),
    )
    await writeFile(
      path.join(projectDir, 'greet.md'),
      skillMarkdown('greet', 'Project greet', 'project', 'Project body.'),
    )

    const skills = await loadSkillsFromDirectories([globalDir, projectDir])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('Project greet')
    expect(skills[0]?.body).toBe('Project body.')
  })

  it('sorts loaded skills by scope precedence', async () => {
    await writeFile(
      path.join(projectDir, 'z-agent.md'),
      skillMarkdown('z-agent', 'An agent skill', 'agent', 'Agent body.'),
    )
    await writeFile(
      path.join(projectDir, 'a-global.md'),
      skillMarkdown('a-global', 'A global skill', 'global', 'Global body.'),
    )

    const skills = await loadSkillsFromDirectories([projectDir])
    expect(skills.map((s) => s.scope)).toEqual(['global', 'agent'])
  })

  it('skips files without valid frontmatter', async () => {
    await writeFile(path.join(globalDir, 'broken.md'), 'no frontmatter here')
    const skills = await loadSkillsFromDirectories([globalDir])
    expect(skills).toHaveLength(0)
  })

  it('tolerates a missing directory', async () => {
    const skills = await loadSkillsFromDirectories([path.join(globalDir, 'does-not-exist')])
    expect(skills).toHaveLength(0)
  })

  describe('selectSkills', () => {
    it('filters by scope', async () => {
      await writeFile(
        path.join(globalDir, 'a.md'),
        skillMarkdown('a', 'desc a', 'global', 'body a'),
      )
      await writeFile(
        path.join(globalDir, 'b.md'),
        skillMarkdown('b', 'desc b', 'project', 'body b'),
      )
      const skills = await loadSkillsFromDirectories([globalDir])
      expect(selectSkills(skills, { scope: ['project'] }).map((s) => s.name)).toEqual(['b'])
    })

    it('filters by query against name and description', async () => {
      await writeFile(
        path.join(globalDir, 'a.md'),
        skillMarkdown('greeter', 'Greets people warmly', 'global', 'body'),
      )
      await writeFile(
        path.join(globalDir, 'b.md'),
        skillMarkdown('farewell', 'Says goodbye', 'global', 'body'),
      )
      const skills = await loadSkillsFromDirectories([globalDir])
      expect(selectSkills(skills, { query: ['goodbye'] }).map((s) => s.name)).toEqual(['farewell'])
      expect(selectSkills(skills, { query: ['greet'] }).map((s) => s.name)).toEqual(['greeter'])
    })
  })

  describe('renderSkillsPrompt', () => {
    it('renders a compact block with name and body per skill', () => {
      const rendered = renderSkillsPrompt([
        { name: 'a', description: 'd', scope: 'global', body: 'Do A.', path: '/a.md' },
        { name: 'b', description: 'd', scope: 'global', body: 'Do B.', path: '/b.md' },
      ])
      expect(rendered).toBe('## a\n\nDo A.\n\n## b\n\nDo B.')
    })

    it('renders an empty string for no skills', () => {
      expect(renderSkillsPrompt([])).toBe('')
    })
  })
})
