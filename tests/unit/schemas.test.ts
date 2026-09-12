import { describe, expect, it } from 'vitest'
import { mapHttpError, isAbortError } from '@main/providers/errors'
import { chatMessagesSchema, settingsSchema, storedMessagesSchema } from '@main/schemas'
import { normalizeHistory } from '@main/store/conversations-core'

describe('mapHttpError（HTTP 错误翻译成人话）', () => {
  it('401/404/429 各有针对性提示', () => {
    expect(mapHttpError(401, '')).toContain('API Key')
    expect(mapHttpError(404, '')).toContain('/v1')
    expect(mapHttpError(429, '')).toContain('额度')
  })

  it('5xx 归为服务端问题', () => {
    expect(mapHttpError(503, '')).toContain('服务端')
  })

  it('未知状态码带原始片段', () => {
    expect(mapHttpError(418, 'teapot')).toContain('418')
    expect(mapHttpError(418, 'teapot')).toContain('teapot')
  })
})

describe('isAbortError', () => {
  it('识别 AbortError', () => {
    const err = new Error('x')
    err.name = 'AbortError'
    expect(isAbortError(err)).toBe(true)
    expect(isAbortError(new Error('y'))).toBe(false)
    expect(isAbortError('string')).toBe(false)
  })
})

describe('settingsSchema（入参闸门）', () => {
  const base = {
    providerType: 'openai-compatible',
    model: 'test-model',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 4096,
    timeoutMs: 60000,
    stream: true,
    contextWindow: 131072,
    reasoningEffort: 'default',
    maxToolRounds: 200,
    supportsImages: false
  }

  it('baseURL 不带协议头自动补 https://', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'api.deepseek.com' })
    expect(parsed.baseURL).toBe('https://api.deepseek.com')
  })

  it('baseURL 已带协议不重复补', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'https://api.deepseek.com/' })
    expect(parsed.baseURL).toBe('https://api.deepseek.com/')
  })

  it('非法 baseURL 拒绝', () => {
    expect(() => settingsSchema.parse({ ...base, baseURL: 'http://' })).toThrow()
  })

  it('max_tokens 超百万闸门拒绝', () => {
    expect(() => settingsSchema.parse({ ...base, baseURL: 'https://x.com', maxTokens: 10_000_000 })).toThrow()
    expect(() => settingsSchema.parse({ ...base, baseURL: 'https://x.com', maxTokens: 384_000 })).toBeTruthy()
  })

  it('采样参数接受 null', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'https://x.com' })
    expect(parsed.temperature).toBe(null)
  })
})

describe('chatMessagesSchema（发给模型的那份）', () => {
  it('空数组拒绝', () => {
    expect(() => chatMessagesSchema.parse([])).toThrow()
  })

  it('合法消息通过', () => {
    expect(chatMessagesSchema.parse([{ role: 'user', content: 'hi' }])).toHaveLength(1)
  })
})

// 存盘那一份**刻意与上面不共用上限**：一个是"一次请求发多少"，一个是"一条会话能有多长"。
// 共用 200 的后果是**超过 200 条消息之后保存永久失败**，而且静默。
describe('storedMessagesSchema（落盘的那一份）', () => {
  const msg = (i: number): { role: 'user'; content: string } => ({
    role: 'user',
    content: `第 ${i} 条`
  })

  it('**超过 200 条照样通过**（这条以前会让长会话永久存不上）', () => {
    const long = Array.from({ length: 300 }, (_, i) => msg(i))
    expect(storedMessagesSchema.parse(long)).toHaveLength(300)
  })

  it('空数组通过 —— 一条还没说过话的会话是合法的', () => {
    expect(storedMessagesSchema.parse([])).toEqual([])
  })

  it('条数仍有上限（防跑飞的渲染进程）', () => {
    const huge = Array.from({ length: 2001 }, (_, i) => msg(i))
    expect(storedMessagesSchema.safeParse(huge).success).toBe(false)
  })

  it('真正防"把 IPC 撑爆"的是**总字数**，且理由是人话', () => {
    const fat = Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'x'.repeat(200000) }))
    const res = storedMessagesSchema.safeParse(fat)
    expect(res.success).toBe(false)
    if (!res.success) {
      // 人话：能直接给用户看，不是 zod 的原始英文
      expect(res.error.issues[0]?.message).toContain('会话太长')
    }
  })

  it('空的 content 仍然拒绝 —— 规整该在前面挡掉，漏到这儿就是程序错了', () => {
    expect(storedMessagesSchema.safeParse([{ role: 'assistant', content: '' }]).success).toBe(false)
  })

  it('**串起来验一次真实路径**：流式中的会话（末尾是空助手占位）能存下去', () => {
    // 这条是给那条数据丢失渠道设的回归门：先规整、再校验，必须通过。
    const streaming = [
      { role: 'user' as const, content: '帮我看看这段代码' },
      { role: 'assistant' as const, content: '' } // ← 刚按下发送、还没吐字
    ]
    // 先说清"为什么要有这条门"：**旧的单一 schema 会把它整个拒掉** ——
    // 修之前 conv:save 用的就是 chatMessagesSchema，于是这几条路必然保存失败。
    expect(chatMessagesSchema.safeParse(streaming).success).toBe(false)
    // 而两条约束分开之后，真实路径是通的：
    const res = storedMessagesSchema.safeParse(normalizeHistory(streaming))
    expect(res.success).toBe(true)
    if (res.success) {
      // 存下去的只有真正有内容的那条
      expect(res.data).toHaveLength(1)
      expect(res.data[0]!.content).toBe('帮我看看这段代码')
    }
  })

  it('**两个 schema 不许再合并回去**（合并 = 长会话永久存不上）', () => {
    // 形状一样、上限刻意不同。合并回去的那一刻，下面两条会同时变红。
    const long = Array.from({ length: 300 }, (_, i) => msg(i))
    expect(chatMessagesSchema.safeParse(long).success).toBe(false) // 发给模型：仍然拦
    expect(storedMessagesSchema.safeParse(long).success).toBe(true) // 落盘：应当放行
  })
})
