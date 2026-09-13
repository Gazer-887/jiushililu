import { describe, expect, it, vi } from 'vitest'
import { createAskBridge } from '@main/ask'
import { createAskTools, type AskReporter } from '@main/agent/tools/ask-tools'
import type { AskAnswer, AskOption, AskRequest } from '@shared/ask'

// Agent 向用户提问（带选项）的双层契约。
// 桥这一层盯的是「没人答复 ≠ 替用户选」：超时 / 中断 / 无窗口都只能回 answered:false；
// 工具这一层盯的是模型看到的文案：用户选了啥要一眼看得出，没作答更不能被当成同意。

const silentLog = (): void => {}

const OPTIONS: AskOption[] = [
  { value: 'opt-1', label: '加糖' },
  { value: 'opt-2', label: '少冰' },
  { value: 'opt-3', label: '都不要' }
]

const askReq = (over: Partial<Omit<AskRequest, 'id'>> = {}): Omit<AskRequest, 'id'> => ({
  question: '奶茶怎么调',
  options: OPTIONS,
  tool: 'ask_user',
  ...over
})

/** 收集推给界面的请求：用数组而不是变量，免得回调里的赋值被 TS 的流分析判成"永远是初值" */
const sentList = (): { sent: AskRequest[]; send: (r: AskRequest) => boolean } => {
  const sent: AskRequest[] = []
  return { sent, send: (r) => (sent.push(r), true) }
}

describe('提问桥：作答', () => {
  it('单选作答 → 同时拿到该选项的 value 与 label', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog })
    const p = bridge.ask(askReq())
    expect(sent).toHaveLength(1)
    expect(bridge.respond({ id: sent[0].id, values: ['opt-2'] })).toBe(true)
    await expect(p).resolves.toEqual({ answered: true, values: ['opt-2'], labels: ['少冰'] })
  })

  it('多选作答 → 按点选顺序回多个 label', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog })
    const p = bridge.ask(askReq({ multiSelect: true }))
    expect(bridge.respond({ id: sent[0].id, values: ['opt-3', 'opt-1'] })).toBe(true)
    await expect(p).resolves.toEqual({
      answered: true,
      values: ['opt-3', 'opt-1'],
      labels: ['都不要', '加糖']
    })
  })

  it('脏值被丢掉，重复值只留一次（界面传来的值不能当真相）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog })
    const p = bridge.ask(askReq())
    expect(bridge.respond({ id: sent[0].id, values: ['opt-9', 'opt-3', 'opt-3'] })).toBe(true)
    await expect(p).resolves.toEqual({ answered: true, values: ['opt-3'], labels: ['都不要'] })
  })
})

describe('提问桥：未作答（不替用户选）', () => {
  it('超时 → timeout，绝不默认第一个选项', async () => {
    vi.useFakeTimers()
    try {
      const { send } = sentList()
      const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 1000 })
      const p = bridge.ask(askReq())
      vi.advanceTimersByTime(1001)
      // toEqual 锁死形状：任何"超时就给个答案"的实现（哪怕选了 opt-1）都会在这里翻车
      await expect(p).resolves.toEqual({ answered: false, reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('abortAll → 全部待决按 aborted 结束，且不再认领回执', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    const a = bridge.ask(askReq())
    const b = bridge.ask(askReq({ question: '第二个问题' }))
    expect(sent).toHaveLength(2)
    bridge.abortAll('窗口已全部关闭')
    await expect(a).resolves.toEqual({ answered: false, reason: 'aborted' })
    await expect(b).resolves.toEqual({ answered: false, reason: 'aborted' })
    expect(bridge.respond({ id: sent[0].id, values: ['opt-1'] })).toBe(false)
  })

  it('推不到界面（无窗口）→ 立刻 no-window，不留待决', async () => {
    const bridge = createAskBridge({ send: () => false, log: silentLog })
    await expect(bridge.ask(askReq())).resolves.toEqual({ answered: false, reason: 'no-window' })
    // 用**可判定的事实**证明没留待决（任何回执都没人认领），而不是加一个自省 API
    expect(bridge.respond({ id: 'any-id', values: ['opt-1'] })).toBe(false)
  })
})

describe('提问桥：回执配对', () => {
  it('不认识的 id → false，原请求仍在等（用真 id 回一次即可证明）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(askReq())
    expect(bridge.respond({ id: 'forged-id', values: ['opt-1'] })).toBe(false)
    expect(bridge.respond({ id: sent[0].id, values: ['opt-1'] })).toBe(true)
    await expect(p).resolves.toEqual({ answered: true, values: ['opt-1'], labels: ['加糖'] })
  })

  it('重复回执同一 id → 第二次被忽略（结果不会被二次改写）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog })
    const p = bridge.ask(askReq())
    expect(bridge.respond({ id: sent[0].id, values: ['opt-1'] })).toBe(true)
    expect(bridge.respond({ id: sent[0].id, values: ['opt-2'] })).toBe(false)
    await expect(p).resolves.toEqual({ answered: true, values: ['opt-1'], labels: ['加糖'] })
  })

  it('两次提问拿到不同的 id', () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    void bridge.ask(askReq())
    void bridge.ask(askReq())
    expect(sent).toHaveLength(2)
    expect(sent[0].id).not.toBe(sent[1].id)
    bridge.abortAll('cleanup')
  })

  it('全是脏值 → false 且不结束，继续等（过期界面传错值不许被翻译成结论）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(askReq())
    let settled = false
    void p.then(() => {
      settled = true
    })
    expect(bridge.respond({ id: sent[0].id, values: ['opt-9', 'nope'] })).toBe(false)
    await Promise.resolve()
    expect(settled).toBe(false)
    bridge.abortAll('cleanup')
    await expect(p).resolves.toEqual({ answered: false, reason: 'aborted' }) // 兜底仍是诚实的未作答
  })
})

describe('提问桥：跳过与自由输入', () => {
  it('明确跳过 → answered:false + skipped（与超时分开，且优先于其它字段）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(askReq())
    // 三个字段一起给：跳过必须赢 —— 用户点的是「跳过本题」，选项与自填都是此前的残留
    expect(bridge.respond({ id: sent[0].id, values: ['opt-1'], text: '随便', skip: true })).toBe(true)
    await expect(p).resolves.toEqual({ answered: false, reason: 'skipped' })
    // 认领过的回执不再被二次改写（重复回执会让"已经定下的结论"被顶掉）
    expect(bridge.respond({ id: sent[0].id, values: ['opt-2'] })).toBe(false)
  })

  it('纯自由输入 → 视为作答，text 原样带回（不是"没回答"，也不受脏值过滤影响）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(askReq())
    // 混一个不在选项里的值：它照旧被丢掉，但**不影响作答发生** —— 这正是"自由输入不被误伤"的判据
    expect(bridge.respond({ id: sent[0].id, values: ['opt-9'], text: '  温的，别放糖  ' })).toBe(true)
    await expect(p).resolves.toEqual({
      answered: true,
      values: [],
      labels: [],
      text: '温的，别放糖' // 前后空白由桥裁掉，正文原样
    })
  })

  it('选项 + 补充 → 两者都带上（选项照旧按 options 还原 label，自填原文附在后面）', async () => {
    const { sent, send } = sentList()
    const bridge = createAskBridge({ send, log: silentLog })
    const p = bridge.ask(askReq())
    expect(bridge.respond({ id: sent[0].id, values: ['opt-2'], text: '再加一份珍珠' })).toBe(true)
    await expect(p).resolves.toEqual({
      answered: true,
      values: ['opt-2'],
      labels: ['少冰'],
      text: '再加一份珍珠'
    })
  })
})

describe('ask_user 工具：给模型看的文案', () => {
  const reporterOf = (
    answer: AskAnswer
  ): { seen: Array<Omit<AskRequest, 'id'>>; reporter: AskReporter } => {
    const seen: Array<Omit<AskRequest, 'id'>> = []
    return {
      seen,
      reporter: {
        async ask(req) {
          seen.push(req)
          return answer
        }
      }
    }
  }

  const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    question: '奶茶怎么调',
    options: [{ label: '加糖' }, { label: '少冰', description: '冰块减半' }],
    ...over
  })

  it('单选作答 → 「用户选择：<label>」', async () => {
    const { reporter } = reporterOf({ answered: true, values: ['opt-2'], labels: ['少冰'] })
    const out = await createAskTools(reporter)[0].execute(args())
    expect(out).toBe('用户选择：少冰')
  })

  it('多选作答 → 顿号连起来', async () => {
    const { reporter } = reporterOf({
      answered: true,
      values: ['opt-1', 'opt-2'],
      labels: ['加糖', '少冰']
    })
    const out = await createAskTools(reporter)[0].execute(args({ multiSelect: true }))
    expect(out).toBe('用户选择：加糖、少冰')
  })

  it('未作答 → 三种原因都写明，并明说"不等于同意"', async () => {
    const cases: Array<[Extract<AskAnswer, { answered: false }>['reason'], string]> = [
      ['timeout', 'timeout'],
      ['aborted', 'aborted'],
      ['no-window', 'no-window']
    ]
    for (const [reason, code] of cases) {
      const { reporter } = reporterOf({ answered: false, reason })
      const out = await createAskTools(reporter)[0].execute(args())
      expect(out).toContain('用户没有回答')
      expect(out).toContain(code)
      expect(out).toContain('不要把这当成同意')
      expect(out).not.toContain('用户选择：') // 没作答就不许出现任何"选择"
    }
  })

  it('作答但无 label（上游实现换了）→ 退到未作答文案，不吐空话', async () => {
    const { reporter } = reporterOf({ answered: true, values: [], labels: [] })
    const out = await createAskTools(reporter)[0].execute(args())
    expect(out).toContain('用户没有回答')
    expect(out).toContain('不要把这当成同意')
  })

  it('三种形态的文案各不相同（图片那个模型分不清"跳过/自填/没回答"就会走错路）', async () => {
    const skip = reporterOf({ answered: false, reason: 'skipped' })
    const skipOut = await createAskTools(skip.reporter)[0].execute(args())
    expect(skipOut).toContain('用户跳过了这个问题 skipped')
    expect(skipOut).toContain('不要把这当成同意')
    expect(skipOut).not.toContain('用户没有回答') // 主动跳过 ≠ 没人理

    const free = reporterOf({ answered: true, values: [], labels: [], text: '来一杯温的' })
    const freeOut = await createAskTools(free.reporter)[0].execute(args())
    expect(freeOut).toBe('用户回答：来一杯温的')

    const both = reporterOf({
      answered: true,
      values: ['opt-2'],
      labels: ['少冰'],
      text: '再加一份珍珠'
    })
    const bothOut = await createAskTools(both.reporter)[0].execute(args())
    expect(bothOut).toBe('用户选择：少冰；用户补充：再加一份珍珠')
  })

  it('选项值由工具层生成，question / multiSelect / tool 原样交给桥', async () => {
    const { seen, reporter } = reporterOf({ answered: true, values: ['opt-1'], labels: ['加糖'] })
    await createAskTools(reporter)[0].execute(args({ multiSelect: true }))
    expect(seen).toHaveLength(1)
    expect(seen[0].question).toBe('奶茶怎么调')
    expect(seen[0].multiSelect).toBe(true)
    expect(seen[0].tool).toBe('ask_user')
    expect(seen[0].options).toEqual([
      { value: 'opt-1', label: '加糖', description: undefined },
      { value: 'opt-2', label: '少冰', description: '冰块减半' }
    ])
  })

  it('少于 2 个选项直接拒，且**不打扰用户**（这不是选择题，该用文字问）', async () => {
    const { seen, reporter } = reporterOf({ answered: true, values: [], labels: [] })
    const out = await createAskTools(reporter)[0].execute(args({ options: [{ label: '加糖' }] }))
    expect(out).toContain('错误')
    expect(out).toContain('不要调本工具')
    expect(seen).toHaveLength(0)
  })

  it('选项超过上限、空 question、空 label 同样被拒', async () => {
    const { reporter } = reporterOf({ answered: true, values: [], labels: [] })
    const tool = createAskTools(reporter)[0]
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ label: `选项${i + 1}` }))
    expect(await tool.execute(args({ options: tooMany }))).toContain('错误')
    expect(await tool.execute(args({ question: '   ' }))).toContain('错误')
    expect(await tool.execute(args({ options: [{ label: '  ' }, { label: '少冰' }] }))).toContain(
      '错误'
    )
  })

  it('工具 schema 也拦住少于 2 个选项（模型侧就看得见边界）', () => {
    const { reporter } = reporterOf({ answered: true, values: [], labels: [] })
    const schema = createAskTools(reporter)[0].schema
    const params = schema.parameters as {
      properties: { options: { minItems: number; maxItems: number } }
    }
    expect(schema.name).toBe('ask_user')
    expect(params.properties.options.minItems).toBe(2)
    expect(params.properties.options.maxItems).toBe(10)
    expect(schema.description).toContain('不要调本工具')
  })
})
