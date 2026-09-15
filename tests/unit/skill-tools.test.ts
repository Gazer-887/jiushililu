import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTools, type ToolHooks } from '@main/agent/runner'
import { createSkillsStore } from '@main/skills/skills-store'

// use_skill 工具的行为与 D-059 条件注册（plan22 §五判据 4 / 5 / 10 / 11）。
// createAllTools 是 runner 的唯一工具装配口 —— 在这一层断言，覆盖的就是真实下发集合。

const ROOT = process.cwd() // createAllTools 需要 workspaceRoot；use_skill 不用文件系统，给个 cwd 即可

function storeWith(skillName: string, source: 'builtin' | 'user' = 'user') {
  const dir = mkdtempSync(join(tmpdir(), 'jsll-skill-tools-'))
  writeFileSync(
    join(dir, `${skillName}.md`),
    `---\ndescription: ${skillName} 的说明\n---\n${skillName} 的技能正文\n`,
    'utf8'
  )
  const store = createSkillsStore({ builtinDir: null, userDir: dir })
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function toolNames(hooks: ToolHooks): string[] {
  return createAllTools(ROOT, hooks).map((t) => t.schema.name)
}

describe('D-059 有消费者才注册', () => {
  it('hooks 未传 skills → use_skill 不下发', () => {
    expect(toolNames({})).not.toContain('use_skill')
  })

  it('hooks 传了 skills（技能清单非空）→ use_skill 下发', () => {
    const { store, cleanup } = storeWith('demo-skill')
    try {
      expect(toolNames({ skills: { store } })).toContain('use_skill')
    } finally {
      cleanup()
    }
  })

  it('传了 skills 但技能目录为空（清单为空）→ use_skill 仍不下发（判据 5）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsll-skill-tools-empty-'))
    try {
      const store = createSkillsStore({ builtinDir: null, userDir: dir })
      expect(store.view().entries).toHaveLength(0)
      expect(toolNames({ skills: { store } })).not.toContain('use_skill')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('use_skill 行为（判据 4 / 10）', () => {
  it('按名加载正文，带来源标注 [技能 user/x]', async () => {
    const { store, cleanup } = storeWith('demo-skill', 'user')
    try {
      const tools = createAllTools(ROOT, { skills: { store } })
      const useSkill = tools.find((t) => t.schema.name === 'use_skill')!
      const out = (await useSkill.execute({ name: 'demo-skill' })) as string
      expect(out).toContain('[技能 user/demo-skill]')
      expect(out).toContain('demo-skill 的技能正文')
    } finally {
      cleanup()
    }
  })

  it('内置来源标注 [技能 builtin/x]（判据 10）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsll-skill-tools-builtin-'))
    writeFileSync(join(dir, 'core-skill.md'), `---\ndescription: 内置说明\nversion: 1.0.0\n---\n内置正文\n`, 'utf8')
    try {
      const store = createSkillsStore({ builtinDir: dir, userDir: null })
      const tools = createAllTools(ROOT, { skills: { store } })
      const useSkill = tools.find((t) => t.schema.name === 'use_skill')!
      const out = (await useSkill.execute({ name: 'core-skill' })) as string
      expect(out).toContain('[技能 builtin/core-skill]')
      expect(out).toContain('（v1.0.0）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在的技能 → 人话报错（含指向清单的指引）', async () => {
    const { store, cleanup } = storeWith('demo-skill')
    try {
      const tools = createAllTools(ROOT, { skills: { store } })
      const useSkill = tools.find((t) => t.schema.name === 'use_skill')!
      const out = (await useSkill.execute({ name: 'no-such' })) as string
      expect(out).toContain('找不到技能')
    } finally {
      cleanup()
    }
  })
})
