import { describe, expect, it } from 'vitest'
import {
  accumulateConversationUsage as add,
  mergeConversationUsage as merge
} from '@shared/conversation-usage'
import { hasReportedUsage, mergeUsageSnapshots } from '@shared/usage'
import type { ConversationMeta } from '@shared/ipc'

const zero = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, reasoningTokens: 0 }
const known = {
  promptTokens: 100,
  completionTokens: 20,
  cachedPromptTokens: 30,
  reasoningTokens: 5
}
const meta = (stats: Partial<ConversationMeta> = {}): ConversationMeta => ({
  id: 'synthetic',
  title: '统计夹具',
  createdAt: 1,
  updatedAt: 1,
  workspace: '',
  model: 'synthetic',
  skills: [],
  messageCount: 0,
  ...stats
})

describe('会话用量来源、覆盖与快照', () => {
  it('无报告但有税：只记本地估算，不赋予厂商0来源', () => {
    expect(add(undefined, { usage: null, memoryTokens: 42 })).toMatchObject({
      usageReported: false,
      usageComplete: false,
      last: null,
      memory: 42
    })
  })
  it('无数字的漏报事实也要记住，后续报告不能伪称完整历史', () => {
    const first = add(undefined, { usage: null })
    const next = add(first, { usage: known, usageComplete: true })
    expect(next).toMatchObject({ total: known, usageReported: true, usageComplete: false })
  })
  it('真实0可报告，完整性与所有明细0保留', () => {
    expect(add(undefined, { usage: zero, usageComplete: true })).toMatchObject({
      total: zero,
      last: zero,
      usageReported: true,
      usageComplete: true
    })
  })
  it('没新报告不把上一轮增量叫本轮，总量不丢', () => {
    const first = add(undefined, { usage: known, usageComplete: true, tier: 'light' })
    expect(add(first, { usage: null })).toMatchObject({
      total: known,
      last: null,
      tier: 'light',
      usageComplete: false
    })
  })
  it('两轮已报相加，缺失明细是未知而非加法单位元', () => {
    const first = add(undefined, {
      usage: { promptTokens: 10, completionTokens: 2 },
      usageComplete: true
    })
    expect(add(first, { usage: known, usageComplete: true }).total).toEqual({
      promptTokens: 110,
      completionTokens: 22,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
  })
  it('重读累计不造最近一轮，档位与反思独立还原', () => {
    expect(
      merge(
        undefined,
        meta({
          usage: known,
          usageReported: true,
          usageComplete: true,
          tokenTier: 'light',
          reflectionUsage: zero
        })
      )
    ).toMatchObject({
      total: known,
      last: null,
      tier: 'light',
      reflectionTotal: zero,
      usageReported: true
    })
  })
  it('旧全0来源未知，原数字保留；旧正数可读但不反推完整性', () => {
    expect(merge(undefined, meta({ usage: zero }))).toMatchObject({
      total: zero,
      usageReported: false
    })
    expect(merge(undefined, meta({ usage: known }))).toMatchObject({
      total: known,
      usageReported: true
    })
    expect(merge(undefined, meta({ usage: known }))?.usageComplete).toBeUndefined()
  })
  it('旧覆盖未知不会因新完整报告变成整份历史完整', () => {
    const old = merge(undefined, meta({ usage: known }))
    expect(add(old, { usage: known, usageComplete: true }).usageComplete).toBeUndefined()
  })
  it('只有false标记也须重启还原，避免忘掉漏报', () => {
    const old = merge(undefined, meta({ usageReported: false, usageComplete: false }))
    expect(old).toBeDefined()
    expect(add(old, { usage: known, usageComplete: true }).usageComplete).toBe(false)
  })
  it('完全没有统计的会话不造空账', () => expect(merge(undefined, meta())).toBeUndefined())
  it('当前档位与最近增量不被晚到快照抹掉', () => {
    const cur = add(undefined, { usage: known, usageComplete: false, tier: 'light' })
    expect(
      merge(cur, meta({ usage: zero, usageReported: true, usageComplete: true, tokenTier: 'rich' }))
    ).toMatchObject({ last: known, tier: 'light', usageComplete: false, total: known })
  })
  it('真0需要来源标记，负值和非有限值不能获得报告资格', () => {
    expect(hasReportedUsage(zero)).toBe(false)
    expect(hasReportedUsage(zero, true)).toBe(true)
    expect(hasReportedUsage({ promptTokens: -1, completionTokens: 0 }, true)).toBe(false)
    expect(hasReportedUsage({ promptTokens: NaN, completionTokens: 0 }, true)).toBe(false)
  })
  it('大范围缺明细不能借小范围数字变成整笔已知', () => {
    const big = { promptTokens: 200, completionTokens: 40 }
    expect(mergeUsageSnapshots(big, known).cachedPromptTokens).toBeNull()
    expect(mergeUsageSnapshots(known, big).reasoningTokens).toBeNull()
    expect(
      mergeUsageSnapshots(known, { ...known, cachedPromptTokens: null }).cachedPromptTokens
    ).toBeNull()
  })
})
