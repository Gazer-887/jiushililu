// 做事纪律纯函数（K6）。判的是"承诺与工具表一致"这一条性质 ——
// 主代理与子代理共用这份代码，所以这里红 = 两边同时坏。
import { describe, expect, it } from 'vitest'
import { composeConductRules } from '@main/agent/conduct-rules'

const numbers = (block: string): number[] =>
  [...block.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))

describe('composeConductRules：按实收工具表取舍', () => {
  it('只给读类工具 ⇒ 不出现 update_todos / set_goal / spawn_agents / run_command 的许诺', () => {
    const block = composeConductRules({ toolNames: ['read_file', 'list_dir', 'search_files'] })
    expect(block).toContain('能查就查')
    expect(block).toContain('跳过 ≠ 通过')
    expect(block).not.toContain('update_todos')
    expect(block).not.toContain('set_goal')
    expect(block).not.toContain('spawn_agents 一次派出')
    expect(block).not.toContain('background=true')
    expect(block).toContain('本轮没有命令执行能力')
  })

  // 判"连续 + 该在的在、不该在的不在"，不判总条数：写死条数的话，以后新增一条无条件规则
  // 就会让这里齐红而行为其实没错 —— 那正是本批在别处删掉的那类脆断言，不该在新文件里再造一遍。
  it('★ 编号必须连续（取舍后不许断号）', () => {
    for (const toolNames of [
      ['read_file'],
      ['read_file', 'update_todos'],
      ['read_file', 'set_goal'],
      ['read_file', 'update_todos', 'set_goal', 'spawn_agents', 'run_command']
    ]) {
      const ns = numbers(composeConductRules({ toolNames }))
      expect(ns.length).toBeGreaterThan(0)
      expect(ns.every((n, i) => n === i + 1)).toBe(true)
    }
  })

  it('★ 有缺口但没有派发口 ⇒ 不许说"派给谁"（出口必须是真话）', () => {
    // gaps 是 runner 算好传进来的；纯函数自己不兜底的话，一个没有 spawn_agents 的会话
    // 会被告知"用 spawn_agents 派给 x" —— 又是一个工具表里没有的名字
    const block = composeConductRules({ toolNames: ['read_file'], gaps: [{ capability: 'run_command', agents: ['x'] }] })
    expect(block).toContain('也没有可派发的子代理提供它')
    expect(block).not.toContain('用 spawn_agents 派给')
  })

  it('清单与目标两条**各自独立**：只给 update_todos 就只许诺它', () => {
    const onlyTodos = composeConductRules({ toolNames: ['update_todos'] })
    expect(onlyTodos).toContain('update_todos')
    expect(onlyTodos).not.toContain('set_goal')
    const onlyGoal = composeConductRules({ toolNames: ['set_goal'] })
    expect(onlyGoal).toContain('set_goal')
    expect(onlyGoal).not.toContain('update_todos')
  })

  it('缺 run_command 但有出口 ⇒ 把名字写进规则，不指向 <self_view>', () => {
    const block = composeConductRules({
      toolNames: ['read_file', 'spawn_agents'],
      gaps: [{ capability: 'run_command', agents: ['code-executor', 'data-executor'] }]
    })
    expect(block).toContain('code-executor、data-executor')
    // 子代理没有自视段，指过去就是悬空指针 —— 所以出口必须内联
    expect(block).not.toContain('<self_view>')
  })

  it('缺 run_command 且无出口 ⇒ 落到"未能验证"分支，不谎称可派', () => {
    const block = composeConductRules({ toolNames: ['read_file'] })
    expect(block).toContain('也没有可派发的子代理提供它')
    expect(block).toContain('未能验证')
  })

  it('同一份工具表两次求值**字节相同**（前缀缓存的前提）', () => {
    const a = composeConductRules({ toolNames: ['read_file', 'run_command'] })
    const b = composeConductRules({ toolNames: ['read_file', 'run_command'] })
    expect(a).toBe(b)
  })
})
