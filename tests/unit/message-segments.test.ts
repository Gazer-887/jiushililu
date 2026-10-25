import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import type { ToolEvent } from '@shared/agent'
import {
  appendSegmentText,
  appendSegmentThinking,
  applyAssistantTool,
  textFromSegments,
  upsertSegmentTool
} from '@shared/message-segments'
import type { ExecEvent } from '@shared/exec-events'
// E29：run_end 摘要判定必须来自真实 TimelinePanel 导出，禁止复制实现给测试
import { runEndSummary } from '../../src/renderer/src/components/TimelinePanel'

// plan36 S2：分段构建的纯函数回归 + store 流式顺序回归（交错序列是卖点本体，此前零覆盖）。

describe('message-segments 纯函数', () => {
  it('相邻同类合并、异类按到达顺序追加（交错的定义就是顺序）', () => {
    let s = appendSegmentThinking(undefined, '先看')
    s = appendSegmentThinking(s, '目录')
    s = appendSegmentText(s, '回答')
    s = appendSegmentText(s, '继续')
    s = appendSegmentThinking(s, '再想')
    expect(s.map((x) => `${x.kind}`)).toEqual(['thinking', 'text', 'thinking'])
    expect(s[0]!.kind === 'thinking' && s[0].text).toBe('先看目录')
  })

  it('tool 段按 id 就地覆盖（start→end 一张卡片），未知 id 追加', () => {
    const start: ToolEvent = { id: 't1', name: 'list_dir', phase: 'start' }
    const end: ToolEvent = { id: 't1', name: 'list_dir', phase: 'end', summary: '8 项' }
    let s = upsertSegmentTool([], start)
    s = upsertSegmentTool(s, end)
    expect(s).toHaveLength(1)
    expect(s[0]!.kind === 'tool' && s[0].event.phase).toBe('end')
    s = upsertSegmentTool(s, { id: 't2', name: 'fetch_url', phase: 'start' })
    expect(s).toHaveLength(2)
  })

  it('全部返回新数组（快照别名坑的根防线：不许就地改）', () => {
    const base = appendSegmentText([], 'a')
    const next = appendSegmentText(base, 'b')
    expect(base).not.toBe(next)
    expect(next).not.toBe(base)
    expect(base[0]!.kind === 'text' && base[0].text).toBe('a')
  })

  it('合同：textFromSegments = text 段拼接（thinking/tool 不参与）', () => {
    let s = appendSegmentThinking([], '想')
    s = appendSegmentText(s, '答')
    s = upsertSegmentTool(s, { id: 'x', name: 'n', phase: 'end' })
    s = appendSegmentText(s, '完')
    expect(textFromSegments(s)).toBe('答完')
  })

  it('旧数据就地迁移：无 segments 有 content 的消息，content 成为首个 text 段', () => {
    const legacy: ChatMessage[] = [{ role: 'assistant', content: '旧报告' }]
    const out = applyAssistantTool(legacy, { id: 't1', name: 'list_dir', phase: 'start' })
    expect(out[0]!.segments?.map((sg) => sg.kind)).toEqual(['text', 'tool'])
    expect(textFromSegments(out[0]!.segments)).toBe('旧报告')
  })
})

// ── E29：run_end 时间线摘要按 terminal 显示，旧事件不推断成功 ───────────────────
// 判据：真实终态合同 §四「TimelinePanel 消费真实状态；旧事件无新字段不推断肯定成功」。
// terminal 优先于 stopReason：二者并存时取 terminal（stopReason 只是旧摘要残料）；
// 文本含 error/success 的运行不得反转 —— 不看正文、不猜状态。

describe('E29 run_end 时间线摘要（runEndSummary 纯函数）', () => {
  const base: Omit<ExecEvent, 'kind' | 'at' | 'conversationId' | 'agentScope'> = {
    rounds: 2,
    durationMs: 1500
  }
  const runEnd = (extra: Record<string, unknown>): ExecEvent =>
    ({ ...base, ...extra, kind: 'run_end', at: '', conversationId: 'A', agentScope: 'main' }) as ExecEvent

  it('六类 terminal 显示准确文字：完成/失败/已取消/已拒绝/未确认/已截断', () => {
    expect(runEndSummary(runEnd({ terminal: { state: 'completed' } }))).toContain('已完成')
    expect(runEndSummary(runEnd({ terminal: { state: 'failed' } }))).toContain('失败')
    expect(runEndSummary(runEnd({ terminal: { state: 'cancelled' } }))).toContain('已取消')
    expect(runEndSummary(runEnd({ terminal: { state: 'denied' } }))).toContain('已拒绝')
    expect(runEndSummary(runEnd({ terminal: { state: 'unknown' } }))).toContain('未确认')
    expect(runEndSummary(runEnd({ terminal: { state: 'truncated' } }))).toContain('已截断')
  })

  it('max-rounds 不显示为成功（预算耗尽 ≠ 完成）', () => {
    const s = runEndSummary(runEnd({ terminal: { state: 'max-rounds', code: 'token-limit' } }))
    expect(s).toContain('轮次耗尽')
    expect(s).not.toContain('已完成')
  })

  it('terminal 优先：与 completed 的 stopReason 并存时按 terminal 显示，文本含 error/success 不反转', () => {
    // 运行正文含 error/success 字样不影响判定：结构事实优先于文本
    expect(runEndSummary(runEnd({ stopReason: 'completed' }))).not.toContain('已完成')
    expect(runEndSummary(runEnd({ stopReason: 'completed', terminal: { state: 'cancelled' } }))).toContain('已取消')
    expect(
      runEndSummary(runEnd({ stopReason: 'completed', terminal: { state: 'failed', code: 'http-error' } }))
    ).toContain('失败')
  })

  it('旧事件无 terminal 保持旧摘要（stopReason 原文），无 stopReason 显示中断，绝不推断成功', () => {
    expect(runEndSummary(runEnd({ stopReason: 'max-rounds' }))).toContain('max-rounds')
    expect(runEndSummary(runEnd({}))).toContain('中断')
    expect(runEndSummary(runEnd({}))).not.toContain('已完成')
    expect(runEndSummary(runEnd({}))).not.toContain('成功')
  })
})

// ── store 流式路径：交错顺序必须长在消息上 ──────────────────────────────

const saved: { id: string; messages: ChatMessage[] }[] = []
const fakeApi = {
  saveConversation: vi.fn(async (id: string, messages: ChatMessage[]) => {
    saved.push({ id, messages: structuredClone(messages) })
    return null
  }),
  chatSend: vi.fn(async () => undefined),
  chatAbort: vi.fn(async () => undefined),
  switchConversation: vi.fn(async () => undefined),
  setKnownWorkspace: vi.fn(async () => undefined),
  getConversation: vi.fn(async (id: string) => ({
    id,
    title: 't',
    workspace: 'D:/ws',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 2,
    messages: [
      { role: 'user', content: '回来再看' },
      {
        role: 'assistant',
        content: '答完',
        segments: [
          { kind: 'thinking', text: '想' },
          { kind: 'tool', event: { id: 't1', name: 'list_dir', phase: 'end' } },
          { kind: 'text', text: '答完' }
        ]
      }
    ]
  }))
}
vi.stubGlobal('window', { api: fakeApi })

// 先立假桥再引 store（与 conversation-routing 同法）
import { useAppStore } from '../../src/renderer/src/store'

const tail = (): ChatMessage => {
  const msgs = useAppStore.getState().messages
  return msgs[msgs.length - 1]
}

describe('store 流式构建：thinking/text/tool 按到达顺序长进消息 segments', () => {
  beforeEach(() => {
    saved.length = 0
    useAppStore.setState({
      activeId: 'A',
      messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '', segments: [] }
      ],
      streaming: true,
      streamError: null,
      saveError: null,
      reasoning: '',
      toolEvents: [],
      runtimes: {}
    })
  })

  it('混合序列 → segments 顺序 = 事件到达顺序，content 与 text 段同步', () => {
    useAppStore.getState().appendReasoning({ conversationId: 'A', payload: '想想。' })
    useAppStore.getState().appendChunk({ conversationId: 'A', payload: '第一段' })
    useAppStore.getState().pushToolEvent({
      conversationId: 'A',
      payload: { id: 't1', name: 'list_dir', phase: 'start' }
    })
    useAppStore.getState().pushToolEvent({
      conversationId: 'A',
      payload: { id: 't1', name: 'list_dir', phase: 'end', summary: '8 项' }
    })
    useAppStore.getState().appendChunk({ conversationId: 'A', payload: '第二段' })
    const m = tail()
    expect((m.segments ?? []).map((sg) => sg.kind)).toEqual(['thinking', 'text', 'tool', 'text'])
    expect(m.content).toBe('第一段第二段')
    expect(textFromSegments(m.segments)).toBe(m.content)
    const tool = m.segments?.[2]
    expect(tool?.kind === 'tool' && tool.event.phase === 'end' && tool.event.summary).toBe('8 项')
  })

  it('后台会话的事件长进**它自己的存档消息**，不碰当前会话（与串台门同律）', () => {
    useAppStore.setState({
      runtimes: {
        B: {
          messages: [
            { role: 'user', content: 'B 问' },
            { role: 'assistant', content: '', segments: [] }
          ],
          streaming: true,
          streamError: null,
          reasoning: '',
          toolEvents: [],
          todos: [],
          subagents: []
        }
      }
    })
    useAppStore.getState().appendChunk({ conversationId: 'B', payload: 'B 的字' })
    expect(tail().content).toBe('')
    const bMsg = useAppStore.getState().runtimes.B!.messages[1]
    expect(bMsg.content).toBe('B 的字')
    expect((bMsg.segments ?? []).map((sg) => sg.kind)).toEqual(['text'])
  })

  it('快照别名钉：archiveCurrent 后再追加，存档里的那份**不许跟着长**', () => {
    useAppStore.getState().appendChunk({ conversationId: 'A', payload: '一' })
    useAppStore.getState().archiveCurrent()
    useAppStore.getState().appendChunk({ conversationId: 'A', payload: '二' })
    const snap = useAppStore.getState().runtimes.A!
    expect(snap.messages[1].content).toBe('一')
    expect(snap.messages[1].segments).toHaveLength(1)
    expect(tail().content).toBe('一二')
  })

  it('S4 重载回归：openConversation 从存储读回的消息**带着 segments 原样进内存**', async () => {
    await useAppStore.getState().openConversation('R')
    const msgs = useAppStore.getState().messages
    expect(msgs).toHaveLength(2)
    expect((msgs[1].segments ?? []).map((sg) => sg.kind)).toEqual(['thinking', 'tool', 'text'])
  })
})
