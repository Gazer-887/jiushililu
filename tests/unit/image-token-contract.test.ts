// plan57 片⓪：图片块的 token 估算契约（K50）。
// 立约的原因不是"现在就出错"，而是片③ 一上线就会中：base64 走文本估法会被放大两个数量级。
import { describe, expect, it } from 'vitest'
import {
  IMAGE_TOKEN_CEIL,
  estimateImageTokens,
  estimatePayloadTokens,
  estimateTokens
} from '@shared/tokens'
import { estimateMessagesTokens } from '@main/agent/context'
import type { AgentMessage } from '@shared/agent'
import type { ChatMessage } from '@shared/ipc'
import { usedTokens } from '../../src/renderer/src/store'

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

  // ↓ 片③ 落地：把契约接到**两个真读数点**。片⓪ 只测了函数本身，接线没人测就等于没接
  //（本项目最恨的那一族：shared 收口了、调用点还在用旧公式 ⇒ 全绿，用户照旧撞裁剪）。
  it('⑥ 裁剪那条读数（estimateMessagesTokens）按块算，一张图不把整段历史折进摘要', () => {
    const turn: AgentMessage = {
      role: 'user',
      content: '看图',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', mime: 'image/png', base64: B64_ONE_SCREENSHOT, ref: 'a.png' }
      ]
    }
    expect(estimateMessagesTokens([turn])).toBeLessThanOrEqual(IMAGE_TOKEN_CEIL + 40)
    // 阳性对照：把 base64 掏空，读数必须**一字不变** —— 只要谁改成按 `JSON.stringify(parts)` 估，
    // 那两个数立刻分家（190 万字符那半截又回来了），这条就是防它
    const light: AgentMessage = {
      role: 'user',
      content: '看图',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', mime: 'image/png', base64: '', ref: 'a.png' }
      ]
    }
    expect(estimateMessagesTokens([light])).toBe(estimateMessagesTokens([turn]))
  })

  it('⑦ 用量牌那个读数（usedTokens）同口径，且文本轮与旧值逐字相同', () => {
    const imgTurn: ChatMessage = {
      role: 'user',
      content: '看图',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', mime: 'image/png', ref: 'a.png', bytes: 900_000 }
      ]
    }
    expect(usedTokens([imgTurn])).toBeLessThanOrEqual(IMAGE_TOKEN_CEIL + 40)
    // 图确实占预算（不是被忽略成 0），同时又没被按字符放大 —— 两个方向一起钉
    expect(usedTokens([imgTurn])).toBeGreaterThan(usedTokens([{ role: 'user', content: '看图' }]))
    expect(usedTokens([{ role: 'user', content: '早' }])).toBe(estimateTokens('早') + 4)
  })
})
