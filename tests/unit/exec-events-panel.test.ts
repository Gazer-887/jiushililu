// 时间线面板的同步点与查询净化单测（plan26 S2 · D-078 / 判据 3）。
// 「五处同步」中能机器判定的部分放这里；switch 穷尽性由 typecheck 兜底（builtinBody 返回 JSX.Element）。
// 源码文本断言沿 stream-envelope.test.ts 的既有口径 —— 认**不依赖排版的锚串**（channel/case 名）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTool, SubagentJobEvent, ToolCall, ToolEvent } from '@shared/agent'
import {
  BUILTIN_LABELS,
  BUILTIN_TYPES
} from '@shared/workbench'
import { IPC } from '@shared/ipc'
import { EXEC_EVENT_LABELS } from '@shared/exec-events'
import { createExecEventRecorder, sanitizeExecEventQuery } from '@main/agent/exec-events'
import { runAgentLoop } from '@main/agent/loop'
import { AgentRunFailure, ProviderError } from '@main/providers/errors'
import { toolStatus } from '../../src/renderer/src/components/MessageSegments'
import { jobStatusText } from '../../src/renderer/src/components/TasksPanel'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('时间线面板 —— 接线同步（判据 3；09-19 从工作台内置页签搬进主对话）', () => {
  it('timeline **不再**是工作台内置页签（已搬走；防有人往 BUILTIN_TYPES 塞回去）', () => {
    expect((BUILTIN_TYPES as readonly string[]).includes('timeline')).toBe(false)
    expect('timeline' in BUILTIN_LABELS).toBe(false)
  })

  it('IPC 通道常量 execEventsList 已登记', () => {
    expect(IPC.execEventsList).toBe('exec-events:list')
  })

  it('时间线挂在主对话：ChatView 引入 TimelinePanel + 头部开关 + 浮层容器', () => {
    const src = read('src/renderer/src/views/ChatView.tsx')
    expect(src).toContain('TimelinePanel')
    expect(src).toContain('chat-tl-toggle')
    expect(src).toContain('chat-tl-panel')
    // 面板自身的数据源仍指向 exec-events:list
    const panel = read('src/renderer/src/components/TimelinePanel.tsx')
    expect(panel).toContain('listExecEvents')
  })

  it('preload 暴露了 listExecEvents，且走 IPC.execEventsList', () => {
    const src = read('src/preload/index.ts')
    expect(src).toContain('listExecEvents')
    expect(src).toContain('IPC.execEventsList')
  })

  it('六种事件 kind 都有界面标签（时间线一行摘要的 kind 列依赖它）', () => {
    for (const [kind, label] of Object.entries(EXEC_EVENT_LABELS)) {
      expect(kind.length).toBeGreaterThan(0)
      expect(label.length).toBeGreaterThan(0)
    }
    expect(Object.keys(EXEC_EVENT_LABELS).sort()).toEqual(
      ['approve', 'run_end', 'run_start', 'tool_call', 'tool_result', 'trim'].sort()
    )
  })
})

describe('exec-events:list 查询净化（sanitizeExecEventQuery）', () => {
  it('非对象输入一律收敛为空查询（不信任渲染端）', () => {
    expect(sanitizeExecEventQuery(null)).toEqual({})
    expect(sanitizeExecEventQuery(undefined)).toEqual({})
    expect(sanitizeExecEventQuery('x')).toEqual({})
    expect(sanitizeExecEventQuery([1, 2])).toEqual({})
    expect(sanitizeExecEventQuery(42)).toEqual({})
  })

  it('conversationId：只收非空字符串（空串/非串丢弃）', () => {
    expect(sanitizeExecEventQuery({ conversationId: 'c1' })).toEqual({ conversationId: 'c1' })
    expect(sanitizeExecEventQuery({ conversationId: '' })).toEqual({})
    expect(sanitizeExecEventQuery({ conversationId: 123 })).toEqual({})
  })

  it('limit：clamp 到 [1, 5000] 并取整（NaN/Infinity/字符串丢弃）', () => {
    expect(sanitizeExecEventQuery({ limit: 100 })).toEqual({ limit: 100 })
    expect(sanitizeExecEventQuery({ limit: 0 })).toEqual({ limit: 1 })
    expect(sanitizeExecEventQuery({ limit: 99999 })).toEqual({ limit: 5000 })
    expect(sanitizeExecEventQuery({ limit: 3.7 })).toEqual({ limit: 3 })
    expect(sanitizeExecEventQuery({ limit: Number.NaN })).toEqual({})
    expect(sanitizeExecEventQuery({ limit: Number.POSITIVE_INFINITY })).toEqual({})
    expect(sanitizeExecEventQuery({ limit: '100' })).toEqual({})
  })

  it('组合：合法字段保留、非法字段丢弃（未知字段不透传）', () => {
    const out = sanitizeExecEventQuery({ conversationId: 'c1', limit: 50, evil: 'x' })
    expect(out).toEqual({ conversationId: 'c1', limit: 50 })
    expect('evil' in out).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E28：tool_result / run_end 固定元数据与工具卡真实终态

describe('E28 执行事件固定元数据与工具卡终态', () => {
  function capture(): { events: Array<Record<string, unknown>>; rec: ReturnType<typeof createExecEventRecorder> } {
    const events: Array<Record<string, unknown>> = []
    const rec = createExecEventRecorder({
      sink: { append: (e) => events.push(e as unknown as Record<string, unknown>) },
      conversationId: 'c-e28',
      agentScope: 'main'
    })
    return { events, rec }
  }

  it('tool_result 只保留固定元数据；ok 由 outcome 强制（仅 succeeded 为 true）', () => {
    const { events, rec } = capture()
    rec.record('tool_result', {
      tool: 'read_file',
      ok: true,
      outcome: 'failed',
      code: 'tool-error',
      exitCode: null,
      content: 'SECRET_BODY',
      args: { path: 'x' },
      usage: { promptTokens: 1 }
    })
    expect(events[0]).toMatchObject({ tool: 'read_file', ok: false, outcome: 'failed', code: 'tool-error', exitCode: null })
    expect('content' in events[0]).toBe(false)
    expect('args' in events[0]).toBe(false)
    expect('usage' in events[0]).toBe(false)
  })

  it('run_end 只允许 terminal 等固定字段，拒绝 usage/正文', () => {
    const { events, rec } = capture()
    rec.record('run_end', {
      rounds: 2,
      durationMs: 9,
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: {},
      body: 'x'
    })
    expect(events[0]).toMatchObject({ rounds: 2, durationMs: 9, terminal: { state: 'failed', code: 'upstream-error' } })
    expect('usage' in events[0]).toBe(false)
    expect('body' in events[0]).toBe(false)
  })

  it('旧事件缺新字段不被补成肯定成功', () => {
    const { events, rec } = capture()
    rec.record('tool_result', { tool: 'x', ok: true })
    expect('outcome' in events[0]).toBe(false)
    expect('terminal' in events[0]).toBe(false)
  })

  it('工具卡按 outcome 显示失败；正文含“成功”也不反转事实', () => {
    const event: ToolEvent = {
      id: 't1',
      name: 'run_command',
      phase: 'end',
      outcome: 'failed',
      summary: '命令输出：成功',
      detail: '执行'
    }
    const status = toolStatus(event)
    expect(status.text).toBe('失败')
    expect(status.icon).toBe('✗')
    expect(status.className).toContain('tool-outcome-failed')
  })

  it('旧 phase=end 无 outcome：沿用旧判据但不写“成功”字样', () => {
    const status = toolStatus({ phase: 'end' })
    expect(status.icon).toBe('✓')
    expect(status.text).toBe('')
  })

  it('工具卡接线：组件使用 toolStatus，不按正文文本判状态', () => {
    const src = read('src/renderer/src/components/MessageSegments.tsx')
    expect(src).toContain('toolStatus(event)')
    expect(src).not.toMatch(/summary[^\n]*(成功|失败)/)
  })

  it('任务卡：terminal 细分类优先，max-rounds 不显示成功，旧事件沿用旧判据', () => {
    const base: SubagentJobEvent = {
      runId: 'r1',
      name: 'worker',
      index: 0,
      phase: 'end',
      task: '合成任务',
      startedAt: 0,
      endedAt: 1000
    }
    expect(jobStatusText({ ...base, terminal: { state: 'failed', code: 'upstream-error' } })).toContain('失败')
    expect(jobStatusText({ ...base, terminal: { state: 'cancelled' } })).toContain('已取消')
    expect(jobStatusText({ ...base, terminal: { state: 'denied' } })).toContain('已拒绝')
    expect(jobStatusText({ ...base, terminal: { state: 'unknown' } })).toContain('未确认')
    expect(jobStatusText({ ...base, terminal: { state: 'truncated' } })).toContain('已截断')
    expect(jobStatusText({ ...base, terminal: { state: 'max-rounds' } })).toContain('轮次耗尽')
    expect(jobStatusText({ ...base, terminal: { state: 'max-rounds' } })).not.toContain('已完成')
    expect(jobStatusText({ ...base })).toContain('已完成')
    expect(jobStatusText({ ...base, phase: 'error' })).toContain('失败')
    expect(jobStatusText({ ...base, phase: 'start' })).toBe('进行中')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E28-R1：从真实 runAgentLoop 入口断言事件传值（不是只测白名单）

describe('E28-R1 Agent 循环把 ToolResult / terminal 传入执行事件', () => {
  function capture(): { events: Array<Record<string, unknown>>; rec: ReturnType<typeof createExecEventRecorder> } {
    const events: Array<Record<string, unknown>> = []
    const rec = createExecEventRecorder({
      sink: { append: (e) => events.push(e as unknown as Record<string, unknown>) },
      conversationId: 'c-loop',
      agentScope: 'main'
    })
    return { events, rec }
  }
  const probe = (execute: AgentTool['execute']): AgentTool => ({
    schema: { name: 'probe', description: 'probe', parameters: {} },
    execute
  })
  const call = (): ToolCall => ({ id: 'call1', name: 'probe', arguments: '{}' })
  const base = (tools: AgentTool[], rec: ReturnType<typeof createExecEventRecorder>, maxRounds = 3) => ({
    systemPrompt: 'synthetic',
    history: [],
    tools,
    execEvents: rec,
    maxRounds
  })

  it('tool_result 只传真实 outcome/code/exitCode', async () => {
    const { events, rec } = capture()
    let n = 0
    await runAgentLoop({
      ...base([probe(async () => ({ text: '坏了', outcome: 'failed', code: 'tool-error' }))], rec),
      chat: async () => (++n === 1 ? { text: null, toolCalls: [call()] } : { text: 'done', toolCalls: [] })
    })
    const tr = events.find((e) => e.kind === 'tool_result')
    expect(tr).toMatchObject({ outcome: 'failed', code: 'tool-error', ok: false })
    expect(tr && 'exitCode' in tr).toBe(false)
  })

  it('工具无 outcome 时事件不补 outcome（不从文本猜）', async () => {
    const { events, rec } = capture()
    let n = 0
    await runAgentLoop({
      ...base([probe(async () => '普通输出')], rec),
      chat: async () => (++n === 1 ? { text: null, toolCalls: [call()] } : { text: 'done', toolCalls: [] })
    })
    const tr = events.find((e) => e.kind === 'tool_result')!
    expect('outcome' in tr).toBe(false)
    expect('code' in tr).toBe(false)
  })

  it('run_end 正常完成带 terminal=completed', async () => {
    const { events, rec } = capture()
    await runAgentLoop({
      ...base([], rec),
      chat: async () => ({ text: 'hello', toolCalls: [] })
    })
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal: { state: 'completed' } })
  })

  it('run_end max-rounds 不被显示为成功', async () => {
    const { events, rec } = capture()
    await runAgentLoop({
      ...base([probe(async () => 'x')], rec, 1),
      chat: async () => ({ text: null, toolCalls: [call()] })
    })
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal: { state: 'max-rounds' } })
  })

  it('run_start 真实携带传入的 agentLabel（白名单字段 agentName）', async () => {
    const { events, rec } = capture()
    const opts = {
      ...base([], rec),
      chat: async () => ({ text: 'ok', toolCalls: [] }),
      // 未修代码上 AgentLoopOptions 无此字段：运行时附加，避免编译期提前暴露（断言仍必须真实红）
      agentLabel: 'E30-P2-Agent'
    } as unknown as Parameters<typeof runAgentLoop>[0]
    await runAgentLoop(opts)
    const start = events.find((e) => e.kind === 'run_start')
    expect(start).toBeTruthy()
    expect(start!['agentName']).toBe('E30-P2-Agent')
  })

  it('run_end 取消：abort → cancelled', async () => {
    const { events, rec } = capture()
    const ac = new AbortController()
    ac.abort()
    await expect(
      runAgentLoop({
        ...base([], rec),
        signal: ac.signal,
        chat: async () => ({ text: 'x', toolCalls: [] })
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal: { state: 'cancelled' } })
  })

  it('run_end 失败/截断/拒绝：沿用异常里的固定 terminal', async () => {
    for (const terminal of [
      { state: 'failed' as const, code: 'http-error' as const },
      { state: 'truncated' as const, code: 'token-limit' as const },
      { state: 'denied' as const, code: 'content-filter' as const }
    ]) {
      const { events, rec } = capture()
      await expect(
        runAgentLoop({
          ...base([], rec),
          chat: async () => {
            throw new ProviderError('固定本地映射', 400, {
              scope: 'request',
              terminal,
              usage: null,
              usageComplete: false
            })
          }
        })
      ).rejects.toBeInstanceOf(ProviderError)
      expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal })
    }
  })

  it('run_end 未知：普通异常 → unknown，不写成成功', async () => {
    const { events, rec } = capture()
    await expect(
      runAgentLoop({
        ...base([], rec),
        chat: async () => {
          throw new Error('boom')
        }
      })
    ).rejects.toThrow('boom')
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal: { state: 'unknown' } })
  })

  it('run_end 读取 AgentRunFailure 的整轮 terminal', async () => {
    const { events, rec } = capture()
    await expect(
      runAgentLoop({
        ...base([], rec),
        chat: async () => {
          throw new AgentRunFailure({
            scope: 'run',
            runId: 'r1',
            terminal: { state: 'failed', code: 'upstream-error' },
            usage: null,
            usageComplete: false
          })
        }
      })
    ).rejects.toBeInstanceOf(AgentRunFailure)
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({ terminal: { state: 'failed', code: 'upstream-error' } })
  })
})
