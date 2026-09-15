import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeSkillBlock,
  validateSkillFields,
  SKILL_BLOCK_MAX_BYTES,
  SKILL_BLOCK_MAX_ITEMS,
  type SkillListItem
} from '@shared/skills'
import { loadSkillEntries, parseSkillDefinition } from '@main/skills/loader'
import { createSkillsStore } from '@main/skills/skills-store'

// 技能系统单测（plan22 S9）。判据编号对应 plan22 §五。
// loader/store 不碰 electron（架构守卫由 architecture.test.ts 沿 import 图看守，见 TEST_ENTRIES）。

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'jsll-skills-'))
}

function writeSkill(dir: string, fileName: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), content, 'utf8')
}

function skillFile(description: string, body = '步骤：按指令执行。'): string {
  return `---\ndescription: ${description}\n---\n${body}\n`
}

describe('validateSkillFields（对齐 Agent Skills 标准）', () => {
  it('合法输入通过', () => {
    expect(validateSkillFields({ name: 'write-commit-message', description: '写提交信息', body: '步骤' }).ok).toBe(true)
  })
  it('name 大写 / 下划线开头拒绝', () => {
    expect(validateSkillFields({ name: 'My-Skill', description: 'x', body: 'x' }).ok).toBe(false)
    expect(validateSkillFields({ name: '_skill', description: 'x', body: 'x' }).ok).toBe(false)
  })
  it('description 超 1024 拒绝（标准上限）', () => {
    expect(validateSkillFields({ name: 'a', description: '长'.repeat(1025), body: 'x' }).ok).toBe(false)
  })
  it('description 为空 / 正文为空拒绝', () => {
    expect(validateSkillFields({ name: 'a', description: '  ', body: 'x' }).ok).toBe(false)
    expect(validateSkillFields({ name: 'a', description: 'x', body: '  ' }).ok).toBe(false)
  })
})

describe('composeSkillBlock（D-057 预算与排序）', () => {
  it('空清单 → block 为 null（D-059 语义）', () => {
    expect(composeSkillBlock([]).block).toBeNull()
  })

  it('排序：用户层条目优先于内置层，同层按 name 字典序（判据 9）', () => {
    const items: SkillListItem[] = [
      { name: 'aaa', description: '内置甲', source: 'builtin' },
      { name: 'zzz', description: '用户乙', source: 'user' },
      { name: 'mmm', description: '内置丙', source: 'builtin' }
    ]
    const { block } = composeSkillBlock(items)
    const order = (block ?? '')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.split(' — ')[0])
    expect(order).toEqual(['- zzz', '- aaa', '- mmm'])
  })

  it('条数上限：30 条 → 24 条入选、droppedByCount=6（判据 3）', () => {
    const items: SkillListItem[] = Array.from({ length: 30 }, (_, i) => ({
      name: `skill-${String(i).padStart(2, '0')}`,
      description: `技能 ${i}`,
      source: 'builtin'
    }))
    const r = composeSkillBlock(items)
    expect(r.droppedByCount).toBe(30 - SKILL_BLOCK_MAX_ITEMS)
    expect(r.droppedByBytes).toBe(0)
    expect(r.block ?? '').toContain(`另有 ${r.droppedByCount} 条技能未列出`)
  })

  it('字节口径：超长中文 description 按字节丢（判据 3，utf8 1 字 ≈ 3 字节）', () => {
    const items: SkillListItem[] = Array.from({ length: 10 }, (_, i) => ({
      name: `s-${i}`,
      // 每条 description ≈ 400 个中文字 ≈ 1200 字节，累计必超 4KB
      description: '描'.repeat(400) + String(i),
      source: 'builtin'
    }))
    const r = composeSkillBlock(items)
    expect(r.droppedByBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(r.block ?? '', 'utf8')).toBeLessThanOrEqual(SKILL_BLOCK_MAX_BYTES)
  })

  it('成品块恒 ≤ 4KB 且按条原子（不出现半行截断）', () => {
    const items: SkillListItem[] = Array.from({ length: 60 }, (_, i) => ({
      name: `long-${i}`,
      description: '内'.repeat(200),
      source: 'builtin'
    }))
    const { block } = composeSkillBlock(items)
    expect(Buffer.byteLength(block ?? '', 'utf8')).toBeLessThanOrEqual(SKILL_BLOCK_MAX_BYTES)
    // 原子性：块内每一行都是完整语义行（标题 / 引导句 / 完整条目 / 尾注），不存在被切断的半个条目
    const bodyLines = (block ?? '').split('\n').filter((l) => l.length > 0)
    for (const l of bodyLines) {
      const complete =
        l === '### 可用技能' ||
        l === '用 use_skill 工具按名加载技能的完整指令：' ||
        l.startsWith('- ') ||
        l.startsWith('（另有 ')
      expect(complete).toBe(true)
    }
  })
})

describe('loadSkillEntries（D-056 两层加载）', () => {
  it('用户层覆盖同名内置：内置标 overridden、生效集合取用户版（判据 1）', () => {
    const builtin = tmpDir()
    const user = tmpDir()
    writeSkill(builtin, 'commit.md', skillFile('内置版说明'))
    writeSkill(user, 'commit.md', skillFile('用户版说明'))
    try {
      const r = loadSkillEntries([
        { dir: builtin, source: 'builtin' },
        { dir: user, source: 'user' }
      ])
      expect(r.entries).toHaveLength(2)
      const builtinEntry = r.entries.find((e) => e.source === 'builtin')
      const userEntry = r.entries.find((e) => e.source === 'user')
      expect(builtinEntry?.overridden).toBe(true)
      expect(userEntry?.overridden).toBe(false)
      expect(userEntry?.description).toBe('用户版说明')
    } finally {
      rmSync(builtin, { recursive: true, force: true })
      rmSync(user, { recursive: true, force: true })
    }
  })

  it('fail-soft：坏 frontmatter 跳过且 warnings 有名有因，其余照常（判据 2）', () => {
    const dir = tmpDir()
    writeSkill(dir, 'good.md', skillFile('好的'))
    writeSkill(dir, 'bad.md', '没有 frontmatter 的坏文件')
    try {
      const r = loadSkillEntries([{ dir, source: 'user' }])
      expect(r.entries.map((e) => e.name)).toEqual(['good'])
      expect(r.warnings.some((w) => w.includes('bad.md') && w.includes('frontmatter'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('技能名来自文件名而非 frontmatter；不一致时给 warning（D-056）', () => {
    const raw = `---\nname: whatever\ndescription: 说明\n---\n正文\n`
    const r = parseSkillDefinition(raw, 'user', '/tmp/actual-name.md', 'user/actual-name.md')
    expect(r.def.name).toBe('actual-name')
    expect(r.warnings.some((w) => w.includes('以文件名'))).toBe(true)
  })
})

describe('createSkillsStore（S3）', () => {
  it('read 只取生效集合：被覆盖的内置技能取不到', () => {
    const builtin = tmpDir()
    const user = tmpDir()
    writeSkill(builtin, 'commit.md', skillFile('内置版'))
    writeSkill(user, 'commit.md', skillFile('用户版'))
    writeSkill(user, 'only-user.md', skillFile('仅用户层'))
    try {
      const store = createSkillsStore({ builtinDir: builtin, userDir: user })
      expect(store.read('commit')?.description).toBe('用户版')
      expect(store.read('only-user')?.description).toBe('仅用户层')
      expect(store.read('不存在的技能')).toBeNull()
    } finally {
      rmSync(builtin, { recursive: true, force: true })
      rmSync(user, { recursive: true, force: true })
    }
  })

  it('reload 重新扫盘并触发 onChange（新增文件可见）', () => {
    const user = tmpDir()
    try {
      const store = createSkillsStore({ builtinDir: null, userDir: user })
      expect(store.view().entries).toHaveLength(0)
      let changed = 0
      store.onChange(() => {
        changed += 1
      })
      writeSkill(user, 'new-one.md', skillFile('新技能'))
      store.reload()
      expect(changed).toBe(1)
      expect(store.view().entries.map((e) => e.name)).toEqual(['new-one'])
    } finally {
      rmSync(user, { recursive: true, force: true })
    }
  })
})
