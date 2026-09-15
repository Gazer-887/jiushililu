// UsageRecord.kind 字段单测（plan19 批 2 判据 5 + 接缝 #23）。
// 钉的判据：
// - UsageRecord 有 kind 字段
// - 反思用量的 kind === 'reflection'
// - 缺省 kind === 'chat'（向后兼容：老记录无此字段，按 chat 算 —— 不标的话会把反思用量误归到对话账）
// - filterByKind 按 kind 筛
//
// ⚠️ kind 用于**事件流归因**；用量牌读的是 ConversationUsage.reflectionTotal
// （审查 B8 P1：用量牌不直接 filterByKind，kind 不进聚合路径）—— 这一点不在本测范围。

import { describe, expect, it } from 'vitest'
import { filterByKind, sumRecords, type UsageRecord } from '@shared/usage'

const rec = (
  p: number,
  c: number,
  opts: { estimated?: boolean; kind?: 'chat' | 'reflection' } = {}
): UsageRecord => ({
  usage: { promptTokens: p, completionTokens: c },
  estimated: opts.estimated ?? false,
  at: 0,
  ...(opts.kind === undefined ? {} : { kind: opts.kind })
})

describe('UsageRecord.kind 字段（批 2 判据 5）', () => {
  it('字段可选：不写就是没这个键（向后兼容老数据）', () => {
    const r: UsageRecord = { usage: { promptTokens: 10, completionTokens: 5 }, estimated: false, at: 0 }
    expect(r.kind).toBeUndefined()
  })

  it('显式设 reflection → 字段带值', () => {
    const r: UsageRecord = {
      usage: { promptTokens: 100, completionTokens: 20 },
      estimated: false,
      at: 0,
      kind: 'reflection'
    }
    expect(r.kind).toBe('reflection')
  })

  it('显式设 chat → 字段带值', () => {
    const r: UsageRecord = {
      usage: { promptTokens: 100, completionTokens: 20 },
      estimated: false,
      at: 0,
      kind: 'chat'
    }
    expect(r.kind).toBe('chat')
  })
})

describe('filterByKind：按 kind 筛', () => {
  it('纯对话记录（全无 kind）→ 按 chat 算，filterByKind(_, "chat") 全返', () => {
    const records = [rec(10, 5), rec(20, 8), rec(30, 10)]
    expect(filterByKind(records, 'chat')).toHaveLength(3)
    expect(filterByKind(records, 'reflection')).toHaveLength(0)
  })

  it('混合记录 → 各取一份', () => {
    const records = [
      rec(10, 5), // chat（无 kind）
      rec(20, 8, { kind: 'reflection' }),
      rec(30, 10, { kind: 'chat' }),
      rec(40, 12, { kind: 'reflection' })
    ]
    expect(filterByKind(records, 'chat')).toHaveLength(2)
    expect(filterByKind(records, 'reflection')).toHaveLength(2)
  })

  it('⚠️ 缺省 kind = "chat"：老数据混进反思数据时，不会把反思误归到对话账', () => {
    // 场景：升级前的老数据没 kind 字段，升级后第一次反思写入 kind='reflection'
    const records = [
      rec(10, 5), // 老数据
      rec(100, 30, { kind: 'reflection' }) // 新数据
    ]
    const chatOnly = filterByKind(records, 'chat')
    const reflectionOnly = filterByKind(records, 'reflection')
    expect(chatOnly).toHaveLength(1)
    expect(reflectionOnly).toHaveLength(1)
    expect(chatOnly[0]?.usage.promptTokens).toBe(10)
    expect(reflectionOnly[0]?.usage.promptTokens).toBe(100)
  })

  it('空数组 → 两个 kind 都返回空（不抛）', () => {
    expect(filterByKind([], 'chat')).toEqual([])
    expect(filterByKind([], 'reflection')).toEqual([])
  })

  it('不修改原数组（filter 不变性）', () => {
    const records = [rec(10, 5), rec(20, 8, { kind: 'reflection' })]
    const before = [...records]
    filterByKind(records, 'chat')
    expect(records).toEqual(before)
  })
})

describe('向后兼容：缺省 kind 与显式 kind 共存的场景', () => {
  it('反思前 N 轮对话 + 后 1 轮反思 → 各自归位', () => {
    const records = [
      rec(100, 20), // 对话轮 1
      rec(120, 25), // 对话轮 2
      rec(80, 15), // 对话轮 3
      rec(500, 100, { kind: 'reflection' }) // 反思轮（反思通常输入大）
    ]
    const chat = filterByKind(records, 'chat')
    const refl = filterByKind(records, 'reflection')
    expect(chat).toHaveLength(3)
    expect(refl).toHaveLength(1)
    // 反思的输入大于对话平均，但不强制（只是说明性断言）
    const reflPrompt = refl[0]?.usage.promptTokens ?? 0
    expect(reflPrompt).toBeGreaterThan(100)
  })

  it('kind 字段不参与算术：filterByKind 后的子集仍可走 sumRecords', () => {
    const records = [
      rec(100, 20),
      rec(500, 100, { kind: 'reflection' })
    ]
    const chatTotal = sumRecords(filterByKind(records, 'chat'))
    const reflTotal = sumRecords(filterByKind(records, 'reflection'))
    expect(chatTotal).toEqual({ promptTokens: 100, completionTokens: 20 })
    expect(reflTotal).toEqual({ promptTokens: 500, completionTokens: 100 })
  })
})
