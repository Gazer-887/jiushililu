import { describe, expect, it } from 'vitest'
import { mapHttpError, isAbortError } from '@main/providers/errors'
import {
  chatMessagesSchema,
  chatSendInputSchema,
  modelSaveSchema,
  settingsSchema,
  storedMessagesSchema
} from '@main/schemas'
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
    inputModalities: ['text']
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

// plan57 片③：`parts` 是**从渲染进程一路传到读盘**的那串字符，schema 是它唯一的形状闸门。
describe('chatMessagesSchema / storedMessagesSchema：图片引用只认受限文件名', () => {
  const good = {
    role: 'user' as const,
    content: '看图 <file name="a.png" kind="image" ref="R" bytes="8" />',
    parts: [{ type: 'text' as const, text: '看图' }, { type: 'image' as const, mime: 'image/png', ref: 'R', bytes: 8 }]
  }
  const REF = '20260927T010203-0-ab12cd.png'

  it('合法引用能过（发送与落盘两条路同一条形状规则）', () => {
    const ok = { ...good, parts: [good.parts[0]!, { ...good.parts[1]!, ref: REF }] }
    expect(chatMessagesSchema.safeParse([ok]).success).toBe(true)
    expect(storedMessagesSchema.safeParse([ok]).success).toBe(true)
  })

  it('★ ref 里塞路径（穿越）/ 塞 URL / 只改后缀，一律拒', () => {
    for (const ref of ['../../etc/passwd', '..\\..\\x.png', 'file:///c:/Windows/x.png', REF + '.png', 'a.png']) {
      const m = { ...good, parts: [{ type: 'text' as const, text: '看图' }, { type: 'image' as const, mime: 'image/png', ref, bytes: 8 }] }
      expect(chatMessagesSchema.safeParse([m]).success, ref).toBe(false)
    }
  })

  it('SVG 不收（两家模型都不吃，放出去只换来一个读不懂的错误串）', () => {
    const m = { ...good, parts: [{ type: 'image' as const, mime: 'image/svg+xml', ref: REF, bytes: 8 }] }
    expect(chatMessagesSchema.safeParse([m]).success).toBe(false)
  })

  it('超单图上限的 bytes 拒；一条消息超过 8 张也拒', () => {
    const one = { type: 'image' as const, mime: 'image/png', ref: REF, bytes: 6 * 1024 * 1024 }
    expect(chatMessagesSchema.safeParse([{ ...good, parts: [one] }]).success).toBe(false)
    const many = Array.from({ length: 9 }, () => ({ type: 'image' as const, mime: 'image/png', ref: REF, bytes: 8 }))
    expect(chatMessagesSchema.safeParse([{ ...good, parts: many }]).success).toBe(false)
  })
})

// plan57 片⑤：视频块进得来、乱格式进不来
describe('视频块的 schema 闸门（K54）', () => {
  const VREF = '20260927T010203-0-ab12cd.mp4'
  const turn = (parts: unknown[]) => [{ role: 'user', content: '看这段', parts }]

  it('mp4 + 合法引用名能过（发送与落盘两条路同一形状规则）', () => {
    const ok = [{ type: 'text', text: '看这段' }, { type: 'video', mime: 'video/mp4', ref: VREF, bytes: 4096 }]
    expect(chatMessagesSchema.safeParse(turn(ok)).success).toBe(true)
    expect(storedMessagesSchema.safeParse(turn(ok)).success).toBe(true)
  })

  it('★ 未实测的容器（quicktime）与假 MIME 一律拒 —— 猜一个没测过的格式出去只会换来读不懂的错', () => {
    for (const mime of ['video/quicktime', 'video/webm', 'image/png']) {
      const parts = [{ type: 'video', mime, ref: VREF, bytes: 4096 }]
      expect(chatMessagesSchema.safeParse(turn(parts)).success, mime).toBe(false)
    }
  })

  it('超单段视频上限拒；引用名不合法（想穿越）拒', () => {
    const big = [{ type: 'video', mime: 'video/mp4', ref: VREF, bytes: 21 * 1024 * 1024 }]
    expect(chatMessagesSchema.safeParse(turn(big)).success).toBe(false)
    const bad = [{ type: 'video', mime: 'video/mp4', ref: '../../etc/passwd', bytes: 4096 }]
    expect(chatMessagesSchema.safeParse(turn(bad)).success).toBe(false)
  })
})

// plan58 片⓪：思考档名改成**逐模型白名单**（R6），校验落在这里。
// 强度声明：这一组全在**校验层**，它管的是"什么进得来盘"；至于"出站时那个值对不对"
// 是 provider 层的事（`thinkingBudgetFor` 的 undefined 兜底），两组缺一不可 ——
// 只有校验层而 provider 不兜底 = NaN 出境；只有 provider 兜底而校验层放行 = 用户存了个永远不生效的值。
describe('modelSaveSchema：思考档名的逐模型白名单（plan58 R6 / Q6b / Q13）', () => {
  const save = (settings: Record<string, unknown>) => ({
    name: '端点',
    providerType: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'k',
    models: [{ id: 'e1', model: 'deepseek-flash', ...(settings ? { settings } : {}) }]
  })

  it('Q13 正向：白名单内的档放行（`max` / `xhigh` 这类官方值都收）', () => {
    for (const eff of ['low', 'high', 'max', 'xhigh', 'minimal']) {
      const r = modelSaveSchema.safeParse(
        save({ reasoningEffort: eff, reasoning: { kind: 'effort', levels: ['low', 'high', 'max', 'xhigh', 'minimal'] } })
      )
      expect(r.success, eff).toBe(true)
    }
  })

  it('★ Q13 反向：同一个值在**没声明该档**的模型上拒绝（白名单是唯一合法性来源）', () => {
    // 这一条是本组的核心：同一个 `max`，上面放行、这里拒绝 ⇒ 判据不可能撞在别处蒙对。
    const r = modelSaveSchema.safeParse(
      save({ reasoningEffort: 'max', reasoning: { kind: 'effort', levels: ['low', 'high'] } })
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(' | ')
      expect(msg).toContain('支持列表')
      // 报错要说清"已经声明了什么"，否则用户在界面上只看到一句"不合法"无从改
      expect(msg).toContain('low')
      expect(msg).toContain('high')
    }
  })

  it('★ 存量兼容：没填 `reasoning` 的模型**不判**（盘上三家端点的档案都没有它）', () => {
    // 反向钉住"把新校验打到老数据上"这个坏修法：一条判据写成"必须有 levels"，
    // 用户下次点保存就被拒 ⇒ 拿新规则打断没升级过的档案。
    for (const eff of ['high', 'xhigh', '外星']) {
      expect(modelSaveSchema.safeParse(save({ reasoningEffort: eff })).success, eff).toBe(true)
    }
  })

  it('填了 `reasoning` 但没填 `levels` ⇒ 也不判（白名单是人工填的，没填就不许替它下结论）', () => {
    expect(modelSaveSchema.safeParse(save({ reasoningEffort: 'medium', reasoning: { kind: 'effort' } })).success).toBe(
      true
    )
  })

  it("R8：`default` 是'不发字段'的哨兵，任何 kind 下都放行（用户随时能切回去）", () => {
    for (const kind of ['effort', 'toggle', 'budget_tokens', 'none'] as const) {
      const r = modelSaveSchema.safeParse(save({ reasoningEffort: 'default', reasoning: { kind } }))
      expect(r.success, kind).toBe(true)
    }
  })

  it('R7 三型形态**不再拒档位**（09-28 改判 R11′：存形状只管形状，发不发由出境层裁决）', () => {
    // 改判前的判据是"三型各自拒档位"（none / toggle / budget_tokens 各一句报错）。
    // 现已撤掉 —— 那些形态下档位是 **inert 数据**：`shared/reasoning.ts · effortToSend`
    // 保证它永不出境，拒它在保存时没有技术道理。
    // ★ 撤掉之后**必须把承重的那半钉在出境层**，否则就是"判据松了但没人接"。
    for (const kind of ['none', 'toggle', 'budget_tokens'] as const) {
      const r = modelSaveSchema.safeParse(save({ reasoningEffort: 'high', reasoning: { kind } }))
      expect(r.success, `${kind} 形态不该再因为档位被拒`).toBe(true)
    }
    // 边界仍在：`kind` 不在四个已知值里照样拒（那是**形状**问题，不是形态与档位矛盾）
    expect(modelSaveSchema.safeParse(save({ reasoningEffort: 'high', reasoning: { kind: '外星' } })).success).toBe(
      false
    )
  })

  it('★ 但 kind 为 effort 且填了 levels 时，白名单**仍然**拒（本组唯一剩下的守卫）', () => {
    // 反向哨兵：防止"为了让 kind=none 那条绿，把整个守卫删了"这种坏修法。
    const r = modelSaveSchema.safeParse(
      save({ reasoningEffort: 'max', reasoning: { kind: 'effort', levels: ['low', 'high'] } })
    )
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.map((i) => i.message).join()).toContain('支持列表')
  })

  it('`kind` 不在四个已知值里 ⇒ 拒；`levels` 空数组拒（空的白名单等于宣称"什么都不支持"，那该用 kind:none）', () => {
    expect(modelSaveSchema.safeParse(save({ reasoning: { kind: '外星' } })).success).toBe(false)
    expect(
      modelSaveSchema.safeParse(save({ reasoning: { kind: 'effort', levels: [] } })).success
    ).toBe(false)
  })

  it('档名本身仍要过形状闸：超长 / 空串拒（32 字符上限只为挡手误与脏数据）', () => {
    expect(modelSaveSchema.safeParse(save({ reasoningEffort: 'x'.repeat(33) })).success).toBe(false)
    expect(modelSaveSchema.safeParse(save({ reasoningEffort: '' })).success).toBe(false)
  })

  it('边界值双向都测：档名 32 字符**放行** / 33 拒；`levels` 12 项放行 / 13 项拒', () => {
    // 为什么单列：魔数（32 / 12）改了**没有判据会提醒**，只会变成"某天闸忽然红了，
    // 报错却指向'档名超长'而实际是上限改了"。双向都要，缺一半就钉不住魔数。
    const eff32 = 'x'.repeat(32)
    expect(modelSaveSchema.safeParse(save({ reasoningEffort: eff32 })).success).toBe(true)
    const lv = (n: number) => Array.from({ length: n }, (_, i) => `lv${i}`)
    const twelve = lv(12)
    // ⚠️ 档名必须取白名单**里**的那一个 —— 第一版这里写死 `'low'` 而 levels 是 `lv0..lv11`，
    // 于是被 Q13 那条正确地拒了，判据自己先翻车。两条判据的取值域必须对齐。
    const ok = (levels: string[]) =>
      modelSaveSchema.safeParse(save({ reasoningEffort: levels[0], reasoning: { kind: 'effort', levels } })).success
    expect(ok(twelve)).toBe(true)
    expect(ok(lv(13))).toBe(false)
  })

  it('`reasoning` 整体类型不符（塞了个字符串而非对象）⇒ 拒', () => {
    expect(modelSaveSchema.safeParse(save({ reasoning: 'effort' })).success).toBe(false)
    expect(modelSaveSchema.safeParse(save({ reasoning: { kind: 'effort', levels: 'low' } })).success).toBe(false)
  })

  it('★ 阳性对照：白名单是**逐条**判的 —— 一个端点里两条模型，一条合规一条不合规时，红的必须是那一条', () => {
    // 防"整表一票否决"那种坏法：一条模型配错就把整个端点拒掉，用户连改都改不了。
    const r = modelSaveSchema.safeParse({
      name: '端点',
      providerType: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'k',
      models: [
        { id: 'ok', model: 'a', settings: { reasoningEffort: 'high', reasoning: { kind: 'effort', levels: ['low', 'high'] } } },
        { id: 'bad', model: 'b', settings: { reasoningEffort: 'max', reasoning: { kind: 'effort', levels: ['low', 'high'] } } }
      ]
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      // path 是**索引**不是条目 id —— 这里判"红的是第 1 条（下标 1）、不是第 0 条"
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('models.1.settings.reasoningEffort')
      expect(paths.some((p) => p.startsWith('models.0.'))).toBe(false)
    }
  })
})
