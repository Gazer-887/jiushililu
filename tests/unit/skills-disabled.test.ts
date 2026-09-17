// plan34 S1：技能 / MCP 禁用名单 —— 「真禁用」的验收（§4.1 判据 1 / 6）。
// 判据原话：**禁用必须"真禁用"—— loader 层确实不注入（技能）/ 工具不下发（MCP），
// 由单测证明，不是看 UI**。只藏 UI 等于假开关。
import { describe, expect, it } from 'vitest'
import { filterDisabledEntries, type SkillListItem } from '@shared/skills'
import { createMcpTools } from '@main/agent/tools/mcp-tools'
import type { McpManager } from '@main/mcp/mcp-manager'

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

describe('createMcpTools · disabledServers（plan34 S1 · MCP 侧真禁用）', () => {
  const mockManager = (refs: { server: string; name: string }[]): McpManager =>
    ({
      activeTools: () =>
        refs.map((r) => ({
          server: r.server,
          name: r.name,
          fullName: `mcp__${r.server}__${r.name}`
        }))
    }) as unknown as McpManager

  const refs = [
    { server: 'alpha', name: 't1' },
    { server: 'beta', name: 't2' }
  ]

  it('★ 被禁用 server 的工具**不下发**（真禁用：模型侧看不到它的工具）', () => {
    const tools = createMcpTools({ manager: mockManager(refs), disabledServers: () => ['alpha'] })
    const names = tools.map((t) => t.schema.name)
    expect(names).toEqual(['mcp__beta__t2'])
  })

  it('不传 disabledServers = 全部下发（老装配兼容，默认开启）', () => {
    const tools = createMcpTools({ manager: mockManager(refs) })
    expect(tools.length).toBe(2)
  })

  it('getter 返回空 = 全部下发；**getter 每次构造时读** → 改开关下一轮即生效（立即生效，Q3）', () => {
    let disabled: string[] = []
    const deps = { manager: mockManager(refs), disabledServers: () => disabled }
    expect(createMcpTools(deps).length).toBe(2)
    // 同一个 deps，名单变了 → 结果跟着变（不需要重建 hooks）
    disabled = ['beta']
    expect(createMcpTools(deps).map((t) => t.schema.name)).toEqual(['mcp__alpha__t1'])
  })

  it('全部禁用 → 下发 0 个工具（调用方语义：模型没有任何 MCP 工具可调）', () => {
    const tools = createMcpTools({ manager: mockManager(refs), disabledServers: () => ['alpha', 'beta'] })
    expect(tools).toEqual([])
  })
})
