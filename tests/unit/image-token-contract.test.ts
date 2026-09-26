// plan57 片⓪：图片块的 token 估算契约（K50）。
// 立约的原因不是"现在就出错"，而是片③ 一上线就会中：base64 走文本估法会被放大两个数量级。
import { describe, expect, it } from 'vitest'
import {
  IMAGE_TOKEN_CEIL,
  estimateImageTokens,
  estimatePayloadTokens,
  estimateTokens
} from '@shared/tokens'

// 一张 1568×882 截图的 base64 长度（约 190 万字符）—— 实测这个量被估成 475,000 token
const B64_ONE_SCREENSHOT = 'A'.repeat(1_900_000)

describe('片⓪ 图片块估算契约（K50 / plan57）', () => {
  it('① 图片块走定额上界，绝不按 base64 字符数算', () => {
    const withImage = estimatePayloadTokens([
      { type: 'text', text: '看看这张图' },
      { type: 'image', data: B64_ONE_SCREENSHOT, width: 1568, height: 882 }
    ])
    expect(withImage).toBeLessThanOrEqual(IMAGE_TOKEN_CEIL + 200)
    // 与"按字符估"的旧口径比：至少差两个数量级，否则这条判据没测到真东西
    expect(estimateTokens(B64_ONE_SCREENSHOT)).toBeGreaterThan(withImage * 100)
  })

  it('② 多张图按张数累加，不按总字节', () => {
    const one = estimatePayloadTokens([{ type: 'image', data: 'A'.repeat(1000) }])
    const three = estimatePayloadTokens([
      { type: 'image', data: 'A'.repeat(1000) },
      { type: 'image', data: 'B'.repeat(900_000) },
      { type: 'image', data: 'C'.repeat(50) }
    ])
    // 只看增量：三张比一张多的量 = 两张的定额（固定开销 +4 不该跟着张数乘）
    expect(three - one).toBe(IMAGE_TOKEN_CEIL * 2)
  })

  it('③ 互反：纯文本 payload 的读数与旧口径逐字相同（防本改造反向误伤）', () => {
    const text = '中文 with mixed English 12345\n换行\t制表'
    expect(estimatePayloadTokens([{ type: 'text', text }])).toBe(estimateTokens(text) + 4)
  })

  it('④ 无尺寸信息时取上界，不许退化成按 base64 长度估', () => {
    expect(estimateImageTokens()).toBe(IMAGE_TOKEN_CEIL)
    expect(estimateImageTokens(4000, 3000)).toBeLessThanOrEqual(IMAGE_TOKEN_CEIL)
  })

  it('⑤ 小图按面积给低值，但不下穿 1（否则多轮累计会凭空免费）', () => {
    const small = estimateImageTokens(64, 64)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(estimateImageTokens(1568, 882))
  })
})
