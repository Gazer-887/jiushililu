import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadAgentsFromDir,
  mergeAgentLayers,
  parseAgentDefinition
} from '@main/agent/loader'
import {
  toAnthropicAgentMessages,
  fromAnthropicResponse,
  toAnthropicToolDefs
} from '@main/providers/anthropic-agent'
import { runSubagents } from '@main/agent/scheduler'
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

  it('合法定义全字段解析', () => {
    const def = parseAgentDefinition(valid, 'project', 'reviewer.md')
    expect(def.name).toBe('reviewer')
    expect(def.description).toBe('代码评审专家')
    expect(def.tools).toEqual(['read_file', 'search'])
    expect(def.model).toBe('deepseek-flash')
    expect(def.systemPrompt).toContain('P0~P3')
    expect(def.source).toBe('project')
  })

  it('tools/model 可省略', () => {
    const def = parseAgentDefinition('---\nname: scout\ndescription: 侦察\n---\n去看。', 'global', 's.md')
    expect(def.tools).toBeUndefined()
    expect(def.model).toBeUndefined()
  })

  it('缺 name 拒绝并指出文件', () => {
    expect(() => parseAgentDefinition('---\ndescription: x\n---\nbody', 'global', 'bad.md')).toThrow('bad.md')
  })

  it('正文为空拒绝', () => {
    expect(() => parseAgentDefinition('---\nname: a\ndescription: b\n---\n', 'global', 'empty.md')).toThrow('职责描述')
  })
})

describe('loadAgentsFromDir / mergeAgentLayers（两级加载与覆盖）', () => {
  it('目录加载 + 项目同名覆盖全局 + 坏文件进 warnings 不静默', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'jsl-agents-g-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'jsl-agents-p-'))

    writeFileSync(join(globalDir, 'reviewer.md'), '---\nname: reviewer\ndescription: 全局评审员\n---\n全局版本', 'utf8')
    writeFileSync(join(globalDir, 'broken.md'), '没有 frontmatter 的坏文件', 'utf8')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'reviewer.md'), '---\nname: reviewer\ndescription: 项目专属评审员\n---\n项目版本', 'utf8')
    writeFileSync(join(projectDir, 'planner.md'), '---\nname: planner\ndescription: 规划员\n---\n做计划。', 'utf8')

    const merged = mergeAgentLayers(globalDir, projectDir)
    expect(merged.definitions.get('reviewer')?.systemPrompt).toBe('项目版本')
    expect(merged.definitions.get('reviewer')?.source).toBe('project')
    expect(merged.definitions.get('planner')).toBeDefined()
    expect(merged.warnings.some((w) => w.includes('broken.md'))).toBe(true)
  })

  it('目录不存在 → 空结果而非报错', () => {
    const res = loadAgentsFromDir(join(tmpdir(), 'jsl-not-exist'), 'global')
    expect(res.definitions.size).toBe(0)
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
