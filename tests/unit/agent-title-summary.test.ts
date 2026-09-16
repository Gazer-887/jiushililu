// S3 单测（plan26 · D-080）：智能标题（判据 5）+ 滚动摘要（判据 7）+ trim 事件（判据 6 的 loop 面）。
// 标题纯函数走直测；摘要走 runAgentLoop 集成（桩 chat + 假 summarize）；runner 的缓存读写
// 用源码守卫钉关键行（其全链路集成归真机冒烟 —— 组件级 mock 成本大于收益，如实登记）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AgentChatResult, AgentMessage } from '@shared/agent'
import { runAgentLoop } from '@main/agent/loop'
import { buildTitlePrompt, deriveTitle, sanitizeGeneratedTitle, createConversationsRepo } from '@main/store/conversations-core'
import type { ConversationsBackend } from '@main/store/conversations-core'
import type { ConversationMeta, ChatMessage } from '@shared/ipc'
import type { ExecEvent } from '@shared/exec-events'
import { createExecEventRecorder } from '@main/agent/exec-events'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(`${ROOT}/${rel}`, 'utf8')

// ── 判据 5：智能标题（纯函数部分）─────────────────────────────────────

describe('智能标题：sanitizeGeneratedTitle（清洗，不许创作）', () => {
  it('正常标题原样保留', () => {
    expect(sanitizeGeneratedTitle('记忆系统重构')).toBe('记忆系统重构')
  })

  it('去常见前缀与包裹：标题：/【】/《》/引号/句末标点', () => {
    expect(sanitizeGeneratedTitle('标题：记忆系统重构')).toBe('记忆系统重构')
    expect(sanitizeGeneratedTitle('Title: Memory refactor')).toBe('Memory refactor')
    expect(sanitizeGeneratedTitle('【记忆系统重构】')).toBe('记忆系统重构')
    expect(sanitizeGeneratedTitle('《记忆系统重构》')).toBe('记忆系统重构')
    expect(sanitizeGeneratedTitle('"记忆系统重构"')).toBe('记忆系统重构')
    expect(sanitizeGeneratedTitle('记忆系统重构。')).toBe('记忆系统重构')
  })

  it('多行只取首行（模型偶尔带解释行）', () => {
    expect(sanitizeGeneratedTitle('记忆系统重构\n这个标题概括了对话主题')).toBe('记忆系统重构')
  })

  it('清洗后为空 → null（调用方退机械标题）', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull()
    expect(sanitizeGeneratedTitle('   ')).toBeNull()
    expect(sanitizeGeneratedTitle(null)).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
  })

  it('超长截断到 24 字 + 省略号', () => {
    const long = '这是一个非常非常非常非常非常非常非常非常非常长的标题内容'
    const out = sanitizeGeneratedTitle(long)!
    expect(out.length).toBeLessThanOrEqual(25)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('智能标题：buildTitlePrompt 组装', () => {
  it('含双方输入与输出纪律（只输出标题本身）', () => {
    const p = buildTitlePrompt('帮我重构记忆系统', '好的，我先看现有实现')
    expect(p).toContain('帮我重构记忆系统')
    expect(p).toContain('好的，我先看现有实现')
    expect(p).toContain('只输出标题本身')
  })

  it('超长输入截断（标题只需知道"在聊什么"）', () => {
    const p = buildTitlePrompt('长'.repeat(1000), '答'.repeat(1000))
    expect(p.length).toBeLessThan(800)
  })
})

// ── 判据 5：setTitleIfEquals（原子条件更新）────────────────────────────

function memBackend(meta: ConversationMeta): { backend: ConversationsBackend; current: () => ConversationMeta } {
  let m = meta
  return {
    backend: {
      readMeta: () => ({ [m.id]: m }),
      putMeta: (_id, next) => {
        m = next
      },
      removeMeta: () => {},
      readMessages: () => [],
      writeMessages: () => {},
      removeMessages: () => {}
    },
    current: () => m
  }
}

const metaOf = (title: string): ConversationMeta => ({
  id: 'c1',
  title,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
  workspace: 'C:/ws'
})

describe('智能标题：setTitleIfEquals（防异步竞态冲掉用户改名）', () => {
  it('条件成立（标题未变）→ 更新', () => {
    const m = memBackend(metaOf('机械标题'))
    const repo = createConversationsRepo(m.backend)
    const out = repo.setTitleIfEquals('c1', '机械标题', '智能标题')
    expect(out?.title).toBe('智能标题')
    expect(m.current().title).toBe('智能标题')
  })

  it('条件不成立（期间被改过）→ 返回 null，标题原样', () => {
    const m = memBackend(metaOf('用户改的标题'))
    const repo = createConversationsRepo(m.backend)
    const out = repo.setTitleIfEquals('c1', '机械标题', '智能标题')
    expect(out).toBeNull()
    expect(m.current().title).toBe('用户改的标题') // 用户改名没被冲掉
  })

  it('会话不存在 / 新标题为空 → null', () => {
    const m = memBackend(metaOf('x'))
    const repo = createConversationsRepo(m.backend)
    expect(repo.setTitleIfEquals('nope', 'x', 'y')).toBeNull()
    expect(repo.setTitleIfEquals('c1', 'x', '   ')).toBeNull()
  })
})

// ── 判据 7：滚动摘要（runAgentLoop 集成）──────────────────────────────

/** 造一段超过 contextWindow*0.75 的历史（触发 trim）：system + 若干轮 */
function longHistory(rounds: number): AgentMessage[] {
  const out: AgentMessage[] = [{ role: 'system', content: '系统提示' }]
  for (let i = 0; i < rounds; i++) {
    out.push({ role: 'user', content: `第 ${i} 轮提问${'填充内容'.repeat(30)}` })
    out.push({ role: 'assistant', content: `第 ${i} 轮回答${'回答内容'.repeat(30)}` })
  }
  return out
}

function memSink(): { events: ExecEvent[]; append: (e: ExecEvent) => void } {
  const events: ExecEvent[] = []
  return { events, append: (e) => void events.push(e) }
}

const chatOk = async (): Promise<AgentChatResult> => ({ text: '好的。', toolCalls: [] })

describe('滚动摘要：裁剪触发 + 摘要进消息流 + trim 事件 summarized（判据 7/6）', () => {
  it('有 summarize：被裁段传入 → 模型摘要替换机械占位 → trim 事件 summarized:true', async () => {
    const sink = memSink()
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    let summarizeInput: AgentMessage[] = []
    const sentMessages: AgentMessage[][] = []
    await runAgentLoop({
      systemPrompt: '系统提示',
      history: longHistory(60),
      tools: [],
      contextWindow: 1000, // 小窗口 → 必触发裁剪
      execEvents: rec,
      chat: async (messages) => {
        sentMessages.push(messages)
        return chatOk()
      },
      summarize: async (dropped) => {
        summarizeInput = dropped
        return '用户在做记忆系统重构，已决定用方案 B。'
      }
    })
    // 被裁段原文传给了摘要回调（内存传递，非事件流）
    expect(summarizeInput.length).toBeGreaterThan(0)
    expect(summarizeInput.some((m) => String(m.content).includes('第 0 轮提问'))).toBe(true)
    // 模型看到的消息里，摘要文本替换了机械占位
    const sent = sentMessages[0]!
    const summaryMsg = sent.find((m) => String(m.content).includes('[历史摘要]'))!
    expect(String(summaryMsg.content)).toContain('用户在做记忆系统重构，已决定用方案 B。')
    expect(String(summaryMsg.content)).not.toContain('要点：')
    // trim 事件：字段齐全 + summarized:true + 不含正文
    const trimEvent = sink.events.find((e) => e.kind === 'trim')!
    expect(trimEvent).toMatchObject({ summarized: true })
    expect(typeof trimEvent.droppedCount).toBe('number')
    expect(typeof trimEvent.bytes).toBe('number')
    expect(JSON.stringify(trimEvent)).not.toContain('第 0 轮提问')
  })

  it('fail-soft：summarize 返回 null → 机械占位仍工作 + summarized:false', async () => {
    const sink = memSink()
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    const sentMessages: AgentMessage[][] = []
    const result = await runAgentLoop({
      systemPrompt: '系统提示',
      history: longHistory(60),
      tools: [],
      contextWindow: 1000,
      execEvents: rec,
      chat: async (messages) => {
        sentMessages.push(messages)
        return chatOk()
      },
      summarize: async () => null
    })
    expect(result.stopReason).toBe('completed')
    const summaryMsg = sentMessages[0]!.find((m) => String(m.content).includes('[历史摘要]'))!
    expect(String(summaryMsg.content)).toContain('要点：') // 机械占位
    expect(sink.events.find((e) => e.kind === 'trim')).toMatchObject({ summarized: false })
  })

  it('fail-soft：summarize 抛异常 → 不崩、机械占位', async () => {
    const sink = memSink()
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    const sentMessages: AgentMessage[][] = []
    const result = await runAgentLoop({
      systemPrompt: '系统提示',
      history: longHistory(60),
      tools: [],
      contextWindow: 1000,
      execEvents: rec,
      chat: async (messages) => {
        sentMessages.push(messages)
        return chatOk()
      },
      summarize: async () => {
        throw new Error('模型超时')
      }
    })
    expect(result.stopReason).toBe('completed')
    expect(String(sentMessages[0]!.find((m) => String(m.content).includes('[历史摘要]'))!.content)).toContain('要点：')
    expect(sink.events.find((e) => e.kind === 'trim')).toMatchObject({ summarized: false })
  })

  it('没给 summarize → 机械占位（现状行为零退化）', async () => {
    const sentMessages: AgentMessage[][] = []
    const result = await runAgentLoop({
      systemPrompt: '系统提示',
      history: longHistory(60),
      tools: [],
      contextWindow: 1000,
      chat: async (messages) => {
        sentMessages.push(messages)
        return chatOk()
      }
    })
    expect(result.stopReason).toBe('completed')
    expect(String(sentMessages[0]!.find((m) => String(m.content).includes('[历史摘要]'))!.content)).toContain('要点：')
  })
})

// ── runner 摘要闭包的源码守卫（缓存读写与记账 —— 全链路集成归真机冒烟）────

describe('runner：摘要闭包的关键行为（源码守卫）', () => {
  const runner = read('src/main/agent/runner.ts')

  it('读旧摘要 + 写新摘要（缓存复用：第二次裁剪不必重新摘要全史）', () => {
    expect(runner).toContain('summaryCache?.get(args.conversationId)')
    expect(runner).toContain('summaryCache?.set(args.conversationId, text)')
  })

  it('摘要调用计入 usageAcc（D-080：账单数字与厂商对得上）', () => {
    const at = runner.indexOf('const summarize =')
    expect(at).toBeGreaterThan(-1)
    const around = runner.slice(at, at + 1400)
    expect(around).toContain('usageAcc = addUsage')
  })

  it('摘要有超时兜底（30s）且不带工具（空 schema）', () => {
    const at = runner.indexOf('const summarize =')
    const around = runner.slice(at, at + 1600)
    expect(around).toContain('AbortSignal.timeout(30_000)')
    expect(around).toContain(', [], () => {}, signal)')
  })

  it('只有组合根给了 summaryCache 才启用（没有 = 机械占位）', () => {
    expect(runner).toContain('...(args.summaryCache ? { summarize } : {})')
  })
})

// ── 标题触发点的源码守卫（convSave 时序 + 只覆盖机械标题）──────────────

describe('ipc：智能标题触发点（源码守卫）', () => {
  const ipc = read('src/main/ipc.ts')

  it('触发挂在 convSave 且限定「1 user + 1 assistant」首答落盘', () => {
    expect(ipc).toContain('maybeGenerateSmartTitle(input.id)')
    expect(ipc).toContain("parsed.data.length === 2 && parsed.data.some((m) => m.role === 'assistant')")
  })

  it('只覆盖机械标题 + 原子条件更新 + 变更广播', () => {
    expect(ipc).toContain('if (conv.title !== expected) return')
    expect(ipc).toContain('setConversationTitleIfEquals(conversationId, expected, clean)')
    expect(ipc).toContain('sendToAll(IPC.convChanged)')
  })

  it('deriveTitle 仍是机械口径（智能标题的 expected 基准）', () => {
    expect(deriveTitle('帮我重构记忆系统')).toBe('帮我重构记忆系统')
    expect(deriveTitle(undefined)).toBe('新对话')
  })
})
