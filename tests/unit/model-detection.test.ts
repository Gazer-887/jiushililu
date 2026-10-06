// K51 落盘映射＋新鲜度单测（纯函数）：按模型 ID 精确匹配，只增不改；失败形状不写盘。
import { describe, expect, it } from 'vitest'
import {
  applyDetectionToEntries,
  DETECT_TTL_MS,
  isDetectionFresh,
  type ModelEntry
} from '@shared/models'

const NOW = 1_700_000_000_000

function entries(): ModelEntry[] {
  return [
    { id: 'e1', model: 'claude-yes' },
    { id: 'e2', model: 'claude-no', settings: { inputModalities: ['text', 'image'] } },
    { id: 'e3', model: 'claude-quiet', name: '静默' }
  ]
}

describe('applyDetectionToEntries（K51 落盘映射）', () => {
  it('true→图文，false→纯文本，且手勾 settings 原样保留', () => {
    const next = applyDetectionToEntries(
      entries(),
      { 'claude-yes': { imageInput: true }, 'claude-no': { imageInput: false } },
      NOW
    )
    expect(next[0].detectedModalities).toEqual(['text', 'image'])
    expect(next[0].detectedAt).toBe(NOW)
    expect(next[0].detectSource).toBe('anthropic-models-api')
    expect(next[1].detectedModalities).toEqual(['text'])
    // 手勾没被探测覆盖：e2 原来勾了 image，settings 一字不动
    expect(next[1].settings).toEqual({ inputModalities: ['text', 'image'] })
    // id/name/model 不动
    expect({ id: next[0].id, model: next[0].model }).toEqual({ id: 'e1', model: 'claude-yes' })
  })

  it('对不上的模型 ID 与缺 imageInput 的条目跳过；全跳过时返回原数组（恒等）', () => {
    const src = entries()
    const next = applyDetectionToEntries(src, { 'ghost-model': { imageInput: true } }, NOW)
    expect(next).toBe(src)
    const next2 = applyDetectionToEntries(src, { 'claude-quiet': {} }, NOW)
    expect(next2).toBe(src)
    expect(next2[2].detectedModalities).toBeUndefined()
  })

  it('capabilities 缺省/空对象 ⇒ 原样返回（失败形状不写盘）', () => {
    const src = entries()
    expect(applyDetectionToEntries(src, undefined, NOW)).toBe(src)
    expect(applyDetectionToEntries(src, {}, NOW)).toBe(src)
  })
})

describe('isDetectionFresh（7 天 TTL）', () => {
  it('新鲜/过期/缺失/未来时间四态', () => {
    expect(isDetectionFresh(NOW, NOW)).toBe(true)
    expect(isDetectionFresh(NOW - DETECT_TTL_MS, NOW)).toBe(true)
    expect(isDetectionFresh(NOW - DETECT_TTL_MS - 1, NOW)).toBe(false)
    expect(isDetectionFresh(undefined, NOW)).toBe(false)
    expect(isDetectionFresh(NaN, NOW)).toBe(false)
    expect(isDetectionFresh(NOW + 1000, NOW)).toBe(false)
  })
})
