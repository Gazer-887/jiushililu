import { describe, expect, it } from 'vitest'
import { mapHttpError, isAbortError } from '@main/providers/errors'
import { chatMessagesSchema, chatSendInputSchema, settingsSchema, storedMessagesSchema } from '@main/schemas'
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

describe('chatSendInputSchema（chat:send 入参）', () => {
  const base = { conversationId: 'c1', messages: [{ role: 'user', content: 'hi' }] }

  it('agentName 可选（plan17）：不带 = 内核默认，老渲染端零回归', () => {
    expect(chatSendInputSchema.safeParse(base).success).toBe(true)
  })

  it('agentName 越界（>64 字符）拒绝', () => {
    expect(chatSendInputSchema.safeParse({ ...base, agentName: 'a'.repeat(65) }).success).toBe(false)
  })
})

// 存盘那份**刻意与上面不共用上限**（一个是"一次请求发多少"，一个是"一条会话能有多长"）
// —— 共用的后果是**超过 200 条消息后保存永久失败**，而且静默。
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
    // 落盘侧靠"先规整、再校验"过；**不规整就必须被拒** —— 这条是 `normalizeHistory` 仍然承重的证据
    // （以前这里断言的是 `chatMessagesSchema` 会拒，那个分工在 K8 之后已不存在）
    expect(storedMessagesSchema.safeParse(streaming).success).toBe(false)
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
    expect(chatMessagesSchema.safeParse(long).success).toBe(false)
    expect(storedMessagesSchema.safeParse(long).success).toBe(true)
  })
})

// K8（0.13.80 真机点验撞出）：一轮回答**正文还没吐出一个字**时点「停止生成」，`markError` 照样落盘，
// 会话里就留下一条 `content: ''` 的 assistant 轮。渲染层按既定规则**保留**它（丢了会让回滚索引错位），
// 于是下一句提问带着它进 `chat:send` → 被 `content.min(1)` 整批拒掉 → **这条会话从此再也发不出消息**，
// 界面只说"参数校验未通过"。落盘侧（`storedMessageSchema`）plan36 早就放行这种形状了，
// 发送侧漏了 —— 两份 schema 对同一条规则各说各话，是这一族的根因。
describe('chatMessagesSchema：空正文的 assistant 轮（K8）', () => {
  it('真机那份历史原样通过（第 4 条是被中断的空正文助手轮）', () => {
    const real = [
      { role: 'user', content: '只派子代理，不要自己执行命令' },
      { role: 'assistant', content: '已派 code-executor 执行，它的原始回报如下：' },
      { role: 'user', content: '用 spawn_agents 一次并行派两个 job' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '先用 update_todos 建三条待办' }
    ]
    expect(chatMessagesSchema.safeParse(real).success).toBe(true)
  })

  it('整条都是空串的 assistant 也放行（与落盘侧 trim 口径一致）', () => {
    expect(chatMessagesSchema.safeParse([{ role: 'assistant', content: '   ' }]).success).toBe(true)
  })

  /** 反向验证：放行必须是**只**放行 assistant，否则这道门等于没关 */
  it('空正文的 user 仍然拒', () => {
    expect(chatMessagesSchema.safeParse([{ role: 'user', content: '' }]).success).toBe(false)
  })

  /** 「空正文」的口径必须与落盘侧一样带 trim —— 不然两份 schema 又会无声分岔（就是 K8 的根因形状） */
  it('只有空格的 user 也算空正文，仍拒', () => {
    expect(chatMessagesSchema.safeParse([{ role: 'user', content: '   ' }]).success).toBe(false)
  })

  it('空正文的 system 仍然拒', () => {
    expect(chatMessagesSchema.safeParse([{ role: 'system', content: '' }]).success).toBe(false)
  })
})
