// plan34 S2a：技能禁用名单 —— 「真禁用」的验收（§4.1 判据 1 / 6）。
// 判据原话：**禁用必须"真禁用"——注入清单里确实没有它，由单测证明，不是看 UI**。
// ⚠️ MCP 侧不走名单（S2b 修正）：开关走配置 `cfg.enabled`（单一真相源），
// `activeTools()` 只认 connected 态 → 被禁 server 的工具天然不下发，机制由 mcp-manager 自己的测试覆盖。
import { describe, expect, it } from 'vitest'
import { filterDisabledEntries, type SkillListItem } from '@shared/skills'

describe('filterDisabledEntries（plan34 S1 · 技能侧真禁用）', () => {
  const items: SkillListItem[] = [
    { name: 'alpha', description: 'a', source: 'builtin' },
    { name: 'beta', description: 'b', source: 'user' },
    { name: 'gamma', description: 'g', source: 'user' }
  ]

  it('★ 被禁用的技能**不出现在注入清单里**（真禁用，不是藏 UI）', () => {
    const out = filterDisabledEntries(items, ['beta'])
    expect(out.map((e) => e.name)).toEqual(['alpha', 'gamma'])
  })

  it('禁用名单为空 = 全开（老配置缺字段 → 默认开启，用户拍板 Q4）', () => {
    expect(filterDisabledEntries(items, [])).toBe(items)
    expect(filterDisabledEntries(items, []).length).toBe(3)
  })

  it('★ 禁用名单里有**不存在的名字** → 不报错也不影响其它条目（僵尸项无害化）', () => {
    const out = filterDisabledEntries(items, ['ghost-skill', 'alpha'])
    expect(out.map((e) => e.name)).toEqual(['beta', 'gamma'])
  })

  it('按名字过滤不区分层 —— 同名覆盖场景：禁掉的就是**实际生效那层**（用户拍板 Q1）', () => {
    // 现实中 store.view() 只出"生效 + 被覆盖标记"的全量视图；注入只取生效条目，
    // 这里模拟"生效条目"被禁 → 不管它来自哪一层，名字对上就消失
    const layered: SkillListItem[] = [
      { name: 'shared-skill', description: '内置版（已被覆盖）', source: 'builtin' },
      { name: 'shared-skill', description: '用户版（生效）', source: 'user' }
    ]
    const out = filterDisabledEntries(layered, ['shared-skill'])
    expect(out.filter((e) => e.name === 'shared-skill' && e.source === 'user')).toEqual([])
  })

  it('全禁 → 注入清单为空（调用方据此跳过注入，D-059 判空语义）', () => {
    expect(filterDisabledEntries(items, ['alpha', 'beta', 'gamma'])).toEqual([])
  })
})
