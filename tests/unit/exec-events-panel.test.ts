// 时间线面板的同步点与查询净化单测（plan26 S2 · D-078 / 判据 3）。
// 「五处同步」中能机器判定的部分放这里；switch 穷尽性由 typecheck 兜底（builtinBody 返回 JSX.Element）。
// 源码文本断言沿 stream-envelope.test.ts 的既有口径 —— 认**不依赖排版的锚串**（channel/case 名）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_LABELS,
  BUILTIN_TYPES
} from '@shared/workbench'
import { IPC } from '@shared/ipc'
import { EXEC_EVENT_LABELS } from '@shared/exec-events'
import { sanitizeExecEventQuery } from '@main/agent/exec-events'

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
