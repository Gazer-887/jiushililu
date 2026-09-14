import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeAgentPrompt,
  loadAgentsFromDir,
  loadAgentEntries,
  parseAgentDefinition
} from '@main/agent/loader'
import {
  toAnthropicAgentMessages,
  fromAnthropicResponse,
  toAnthropicToolDefs
} from '@main/providers/anthropic-agent'
import { runSubagents } from '@main/agent/scheduler'
import type { AgentChatResult, AgentMessage } from '@shared/agent'

describe('parseAgentDefinition（定义解析）', () => {
  const valid = `---
name: reviewer
description: 代码评审专家
tools: [read_file, search]
model: deepseek-flash
---
只报告可证明的问题，按 P0~P3 分级。`

  it('合法定义全字段解析，file 原样带出', () => {
    const def = parseAgentDefinition(valid, 'project', '/tmp/x/reviewer.md', 'project/reviewer.md')
    expect(def.name).toBe('reviewer')
    expect(def.description).toBe('代码评审专家')
    expect(def.tools).toEqual(['read_file', 'search'])
    expect(def.model).toBe('deepseek-flash')
    expect(def.systemPrompt).toContain('P0~P3')
    expect(def.source).toBe('project')
    expect(def.file).toBe('/tmp/x/reviewer.md')
  })

  it('tools/model 可省略', () => {
    const def = parseAgentDefinition('---\nname: scout\ndescription: 侦察\n---\n去看。', 'user', '/x/s.md', 'user/s.md')
    expect(def.tools).toBeUndefined()
    expect(def.model).toBeUndefined()
  })

  it('缺 name 拒绝并指出文件', () => {
    expect(() => parseAgentDefinition('---\ndescription: x\n---\nbody', 'user', '/x/bad.md', 'bad.md')).toThrow('bad.md')
  })

  it('正文为空拒绝', () => {
    expect(() => parseAgentDefinition('---\nname: a\ndescription: b\n---\n', 'user', '/x/e.md', 'e.md')).toThrow('职责描述')
  })

  it('composeAgentPrompt：主循环不自称子代理，子代理自称子代理（plan17 D10）', () => {
    const def = { name: 'planner', description: '规划员', systemPrompt: '做计划。' }
    expect(composeAgentPrompt(def, 'main')).toMatch(/^你是「planner」/)
    expect(composeAgentPrompt(def, 'main')).not.toContain('子代理')
    expect(composeAgentPrompt(def, 'subagent')).toMatch(/^你是子代理「planner」/)
  })
})

describe('loadAgentsFromDir / loadAgentEntries（三层加载与覆盖，plan17 D2）', () => {
  it('目录加载 + 坏文件进 warnings 不静默 + file 指向真实来源', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-agents-u-'))
    writeFileSync(join(dir, 'reviewer.md'), '---\nname: reviewer\ndescription: 评审员\n---\n评审', 'utf8')
    writeFileSync(join(dir, 'broken.md'), '没有 frontmatter 的坏文件', 'utf8')

    const res = loadAgentsFromDir(dir, 'user')
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]!.name).toBe('reviewer')
    expect(res.entries[0]!.file).toBe(join(dir, 'reviewer.md'))
    expect(res.warnings.some((w) => w.includes('broken.md'))).toBe(true)
  })

  it('三层覆盖顺序：项目 > 用户 > 内置；被覆盖层保留展示并标 overridden；生效集合=未覆盖', () => {
    const builtinDir = mkdtempSync(join(tmpdir(), 'jsl-agents-b-'))
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-u-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'jsl-agents-p-'))

    writeFileSync(join(builtinDir, 'planner.md'), '---\nname: planner\ndescription: 内置规划\n---\n内置版本', 'utf8')
    writeFileSync(join(userDir, 'planner.md'), '---\nname: planner\ndescription: 用户规划\n---\n用户版本', 'utf8')
    writeFileSync(join(projectDir, 'planner.md'), '---\nname: planner\ndescription: 项目规划\n---\n项目版本', 'utf8')
    writeFileSync(join(userDir, 'scout.md'), '---\nname: scout\ndescription: 侦察\n---\n去看。', 'utf8')

    const res = loadAgentEntries([
      { dir: builtinDir, source: 'builtin' },
      { dir: userDir, source: 'user' },
      { dir: projectDir, source: 'project' }
    ])
    const plannerAll = res.entries.filter((e) => e.name === 'planner')
    expect(plannerAll).toHaveLength(3) // 全量视图：每文件一条，覆盖关系可见
    const plannerLive = plannerAll.find((e) => !e.overridden)!
    expect(plannerLive.source).toBe('project')
    expect(plannerLive.systemPrompt).toBe('项目版本')
    expect(plannerAll.filter((e) => e.overridden)).toHaveLength(2)

    const effective = res.entries.filter((e) => !e.overridden)
    expect(effective.find((e) => e.name === 'scout')?.source).toBe('user')
  })

  it('同层重名：生效集合只留一条，重名进 warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-agents-dup-'))
    writeFileSync(join(dir, 'a.md'), '---\nname: dup\ndescription: 第一份\n---\nA', 'utf8')
    writeFileSync(join(dir, 'b.md'), '---\nname: dup\ndescription: 第二份\n---\nB', 'utf8')

    // 重名裁决发生在 loadAgentEntries（跨层覆盖同一处）；loadAgentsFromDir 只收集不裁决
    const res = loadAgentEntries([{ dir, source: 'user' }])
    expect(res.entries.filter((e) => e.name === 'dup')).toHaveLength(1)
    expect(res.warnings.some((w) => w.includes('重名'))).toBe(true)
  })

  it('目录不存在 → 空结果而非报错', () => {
    const res = loadAgentsFromDir(join(tmpdir(), 'jsl-not-exist'), 'user')
    expect(res.entries).toHaveLength(0)
  })
})

describe('内置定义（resources/agents，随包分发）', () => {
  // 直接读仓库里的真实定义文件：定义内容坏了这里红，不用等打包后才发现
  const dir = join(process.cwd(), 'resources', 'agents')

  it('全部可解析且无 warnings（name 满足 loader 规则 = 表单口径）', () => {
    const res = loadAgentsFromDir(dir, 'builtin')
    expect(res.entries.length).toBeGreaterThanOrEqual(10)
    expect(res.warnings).toEqual([])
    for (const e of res.entries) {
      expect(e.name).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      expect(e.description.length).toBeGreaterThan(0)
      expect(e.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('三领域覆盖：规划 ≥3 / 执行 ≥4 / 审查 ≥3（2026-09-14 用户拍板的数量要求）', () => {
    const res = loadAgentsFromDir(dir, 'builtin')
    const names = res.entries.map((e) => e.name)
    expect(names.filter((n) => n.endsWith('-planner')).length).toBeGreaterThanOrEqual(3)
    expect(names.filter((n) => n.endsWith('-executor')).length).toBeGreaterThanOrEqual(4)
    expect(names.filter((n) => n.endsWith('-reviewer')).length).toBeGreaterThanOrEqual(3)
  })
})

describe('Anthropic tool_use 翻译器', () => {
  it('system 提取 + tool 结果合并进同一条 user 消息', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: '内核规则' },
      { role: 'user', content: '查文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
          { id: 't2', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }
        ]
      },
      { role: 'tool', content: '文件内容', tool_call_id: 't1' },
      { role: 'tool', content: '搜索结果', tool_call_id: 't2' }
    ]
    const { system, messages: translated } = toAnthropicAgentMessages(messages)
    expect(system).toBe('内核规则')
    expect(translated).toHaveLength(3)
    const assistant = translated[1]!
    expect(assistant.role).toBe('assistant')
    expect(assistant.content.filter((b) => b.type === 'tool_use')).toHaveLength(2)
    const toolResultMsg = translated[2]!
    expect(toolResultMsg.role).toBe('user')
    const results = toolResultMsg.content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(2)
  })

  it('响应解析：text 与 tool_use 分流', () => {
    const res = fromAnthropicResponse({
      content: [
        { type: 'text', text: '我需要读文件' },
        { type: 'tool_use', id: 't9', name: 'read_file', input: { path: 'a.txt' } }
      ]
    })
    expect(res.text).toBe('我需要读文件')
    expect(res.toolCalls).toEqual([{ id: 't9', name: 'read_file', arguments: '{"path":"a.txt"}' }])
  })

  it('工具定义映射：parameters → input_schema', () => {
    const defs = toAnthropicToolDefs([
      { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }
    ])
    expect(defs[0]!.input_schema).toEqual({ type: 'object', properties: {} })
  })
})

describe('runSubagents（子代理调度器）', () => {
  it('并发受限且全部完成、结果按名字可查', async () => {
    let active = 0
    let peak = 0
    const defs = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      name: n,
      description: `${n} 的职责`,
      systemPrompt: `${n} 的纪律`,
      source: 'global' as const
    }))
    const results = await runSubagents({
      definitions: defs,
      task: '干活',
      tools: [],
      maxConcurrency: 2,
      maxRoundsPerAgent: 3,
      chatFactory: (def) => async (messages: AgentMessage[]) => {
        active++
        peak = Math.max(peak, active)
        const text = `${def.name} 干完了`
        await new Promise((r) => setTimeout(r, 20))
        active--
        void messages
        return { text, toolCalls: [] } satisfies AgentChatResult
      }
    })
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.ok && r.output === `${r.name} 干完了`)).toBe(true)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('单代理异常不拖垮其余（error 进结果）', async () => {
    const defs = [
      { name: 'good', description: '好', systemPrompt: '干', source: 'global' as const },
      { name: 'bad', description: '坏', systemPrompt: '炸', source: 'global' as const }
    ]
    const results = await runSubagents({
      definitions: defs,
      task: 'x',
      tools: [],
      chatFactory: (def) => async () => {
        if (def.name === 'bad') throw new Error('模型通道炸了')
        return { text: '完成', toolCalls: [] }
      }
    })
    expect(results.find((r) => r.name === 'good')?.ok).toBe(true)
    expect(results.find((r) => r.name === 'bad')?.ok).toBe(false)
    expect(results.find((r) => r.name === 'bad')?.error).toContain('炸了')
  })
})
