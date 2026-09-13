import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { trimMessages } from '../../src/main/agent/context'
import { outputDisciplinePrompt } from '@shared/token-tier'
import type { AgentMessage } from '@shared/agent'

/**
 * **前缀稳定**（plan8 R9.1 §七④）—— 零代价的省，**四档都要守**。
 *
 * DSH 面板实测：输入 1036.88M 中 1029.66M 命中缓存（99.3%）—— 前缀一变，
 * 从变化点往后**全部失效**，得按未命中重新计费。
 * 所以守两件事：① 系统提示必须静态（它拼在最前，是最大一块前缀）；
 * ② 折叠历史往**中间**插「[历史摘要]」，代价已知且值得，但不许越界。
 */

describe('前缀稳定：系统提示的组成必须是静态的', () => {
  const runner = readFileSync('src/main/agent/runner.ts', 'utf8')
  const loop = readFileSync('src/main/agent/loop.ts', 'utf8')

  it('system 消息拼在**消息列表最前面**（那就是最大的一块前缀）', () => {
    expect(loop).toContain("{ role: 'system', content: opts.systemPrompt }")
  })

  it('系统提示的拼接里**不许出现会变的东西**（时间 / 随机 / uuid）', () => {
    // 只看 `guardedSystem` 那一段构造：往里塞 Date.now / random / uuid 这条就红
    const at = runner.indexOf('const guardedSystem =')
    expect(at).toBeGreaterThan(-1)
    const around = runner.slice(at, at + 600)
    expect(around).not.toMatch(/Date\.now|new Date|Math\.random|randomUUID|nanoid/)
  })

  it('纪律提示里不许出现日期 / 时间 / 会话 id（§七③ 已钉，这里在"前缀"语境下再钉一次）', () => {
    for (const level of [1, 2] as const) {
      const p = outputDisciplinePrompt(level) ?? ''
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|conversationId|runId/i)
    }
  })
})

describe('折叠历史的破坏点：知道它在哪，且不许越界', () => {
  /** 造一段够长的历史：system + 若干轮问答 */
  const build = (rounds: number): AgentMessage[] => {
    const out: AgentMessage[] = [{ role: 'system', content: '系统提示（静态）' }]
    for (let i = 0; i < rounds; i++) {
      out.push({ role: 'user', content: `第 ${i} 轮的提问${'填充'.repeat(20)}` })
      out.push({ role: 'assistant', content: `第 ${i} 轮的回答${'内容'.repeat(20)}` })
    }
    return out
  }

  it('没超阈值时**一条都不动**（连引用都不换）', () => {
    const msgs = build(3)
    const r = trimMessages(msgs, { contextWindow: 1_000_000 })
    expect(r.trimmed).toBe(false)
    expect(r.messages).toBe(msgs)
  })

  it('折叠之后 **system 仍在第一条**（前缀的下限：至少开头那段没被挪走）', () => {
    const msgs = build(200)
    const r = trimMessages(msgs, { contextWindow: 2000 })
    expect(r.trimmed).toBe(true)
    expect(r.messages[0]?.role).toBe('system')
    expect(r.messages[0]?.content).toBe('系统提示（静态）')
  })

  it('摘要**插在中间** —— 这正是"从该点起缓存失效"的位置', () => {
    const msgs = build(200)
    const r = trimMessages(msgs, { contextWindow: 2000 })
    const idx = r.messages.findIndex((m) => String(m.content).startsWith('[历史摘要]'))
    expect(idx).toBeGreaterThan(0)
    expect(idx).toBeLessThan(r.messages.length - 1)
  })

  it('最近若干条**原样保留**（折叠只动中段，尾部完好）', () => {
    const msgs = build(200)
    const r = trimMessages(msgs, { contextWindow: 2000 })
    expect(r.messages[r.messages.length - 1]?.content).toBe(msgs[msgs.length - 1]?.content)
  })
})

describe('接线守卫：折叠这个代价**必须留痕**', () => {
  const loop = readFileSync('src/main/agent/loop.ts', 'utf8')

  it('折叠时记一条日志（将来解释"这轮 token 为什么跳高"的答案）', () => {
    expect(loop).toContain('if (trim.trimmed)')
    expect(loop).toContain('历史已折叠：前缀缓存将从摘要处失效')
  })
})

// 2026-09-13 实测：一条"只要求跑一次命令"的任务，模型跑了 9 次工具调用（第 1 次就拿到完整输出）
// —— 不是没看到，是措辞在推它反复确认。下面这条守的就是那处措辞。
describe('提示措辞守卫：不许把模型推向"再来一轮"', () => {
  const runner = readFileSync('src/main/agent/runner.ts', 'utf8')

  it('做事纪律里点明了"输出多不等于耗时长"（否则大输出命令会被转后台，白烧好几轮）', () => {
    expect(runner).toContain('"输出多"不等于"耗时长"')
    expect(runner).toContain('不要因为"它输出会很长"就转后台')
  })
})
