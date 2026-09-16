import { describe, expect, it, vi } from 'vitest'
import { createPlanApprovalBridge } from '@main/agent/plan-approval'

// 计划批准桥（plan27）—— 与 confirm 桥同源的**安全属性**：
// **没人答复必须拒绝**。差别在载荷与等待时长（方案是长文本，读完要分钟级；命令一眼就能答）。
// 所以这组用例不重复 confirm 的全部维度，只盯三点：
// ① 安全默认（超时/推送失败/中止/abortAll 全按拒绝）；
// ② 长文本载荷原样透传（界面要靠它渲染，桥不能截断或改写）；
// ③ 结论回调 reason 分型（时间线要能分辨"拒是怎么来的"）。

const req = (over: Partial<Parameters<ReturnType<typeof createPlanApprovalBridge>['request']>[0]> = {}) => ({
  agent: '详设规划',
  plan: '## 方案\n1. 改 runner.ts\n2. 加测试',
  conversationId: 'conv-1',
  ...over
})

const silentLog = (): void => {}

describe('计划批准桥：无人应答 = 拒绝（安全默认）', () => {
  it('超时未答复 → 拒绝（不是放行）', async () => {
    vi.useFakeTimers()
    try {
      const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 1000 })
      const p = bridge.request(req())
      vi.advanceTimersByTime(1001)
      await expect(p).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('推不到界面（无窗口）→ 立即拒绝，不留待决', async () => {
    const bridge = createPlanApprovalBridge({ send: () => false, log: silentLog })
    await expect(bridge.request(req())).resolves.toBe(false)
    // 不留待决：用**可判定的事实**（任何答复都没人认领），而不是一个自省用的 API
    expect(bridge.respond({ id: 'any-id', allowed: true })).toBe(false)
  })

  it('窗口全关时 abortAll → 待决请求按拒绝处理', async () => {
    const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.request(req())
    bridge.abortAll('窗口已全部关闭')
    await expect(p).resolves.toBe(false)
  })

  it('abortAll 清空全部待决（一个都不漏）', async () => {
    const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 60_000 })
    const a = bridge.request(req({ agent: 'A' }))
    const b = bridge.request(req({ agent: 'B' }))
    const c = bridge.request(req({ agent: 'C' }))
    bridge.abortAll('渲染进程崩溃')
    await expect(Promise.all([a, b, c])).resolves.toEqual([false, false, false])
  })

  it('本轮已中止 → 立即拒绝，不建永远等不到的待决项', async () => {
    const ac = new AbortController()
    ac.abort()
    const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 60_000 })
    await expect(bridge.request(req(), { signal: ac.signal })).resolves.toBe(false)
  })

  it('等待中途被中止 → 按拒绝收尾，且之后答复不再匹配', async () => {
    const ac = new AbortController()
    let capturedId = ''
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        capturedId = r.id
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    const p = bridge.request(req(), { signal: ac.signal })
    ac.abort()
    await expect(p).resolves.toBe(false)
    // 中止后该项已出队，迟到的答复不该被认领
    expect(bridge.respond({ id: capturedId, allowed: true })).toBe(false)
  })
})

describe('计划批准桥：答复配对', () => {
  it('用户批准 → 返回 true', async () => {
    let captured: { id: string } | null = null
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.request(req())
    expect(captured).not.toBeNull()
    expect(bridge.respond({ id: captured!.id, allowed: true })).toBe(true)
    await expect(p).resolves.toBe(true)
  })

  it('用户拒绝 → 返回 false', async () => {
    let captured: { id: string } | null = null
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.request(req())
    expect(bridge.respond({ id: captured!.id, allowed: false })).toBe(true)
    await expect(p).resolves.toBe(false)
  })

  it('不认识的 id 被忽略（过期/伪造响应不会误配新请求）', async () => {
    let capturedId = ''
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        capturedId = r.id
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    const p = bridge.request(req())
    expect(bridge.respond({ id: 'forged-id', allowed: true })).toBe(false)
    // 原请求仍在等 —— 用它的**真 id** 回一次就能证明（而不是问桥"你还有没有待决"）
    expect(bridge.respond({ id: capturedId, allowed: false })).toBe(true)
    bridge.abortAll('cleanup')
    await expect(p).resolves.toBe(false)
  })

  it('重复答复同一 id → 第二次被忽略（不会二次改写结果）', async () => {
    let captured: { id: string } | null = null
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.request(req())
    expect(bridge.respond({ id: captured!.id, allowed: true })).toBe(true)
    expect(bridge.respond({ id: captured!.id, allowed: false })).toBe(false)
    await expect(p).resolves.toBe(true) // 仍是第一次的答案
  })

  it('两次请求拿到不同的 id', () => {
    const ids: string[] = []
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        ids.push(r.id)
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    void bridge.request(req())
    void bridge.request(req())
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    bridge.abortAll('cleanup')
  })
})

describe('计划批准桥：载荷透传', () => {
  it('方案全文原样送到界面（桥不截断、不改写 —— 界面要靠它渲染给用户读）', () => {
    const long = `## 方案\n${'x'.repeat(5000)}\n## 风险\n- 占位`
    let sent = ''
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        sent = r.plan
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    void bridge.request(req({ plan: long }))
    expect(sent).toBe(long)
    bridge.abortAll('cleanup')
  })

  it('agent 名与会话 id 一并送达（时间线要能归位到是谁、在哪一轮）', () => {
    let seen: { agent: string; conversationId: string } | null = null
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        seen = { agent: r.agent, conversationId: r.conversationId }
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    void bridge.request(req({ agent: '详设规划', conversationId: 'conv-42' }))
    expect(seen).toEqual({ agent: '详设规划', conversationId: 'conv-42' })
    bridge.abortAll('cleanup')
  })
})

describe('计划批准桥：结论回调 reason 分型', () => {
  const collect = () => {
    const seen: Array<{ allowed: boolean; reason: string; agent: string }> = []
    return { seen, onDecide: (i: { allowed: boolean; reason: string; agent: string }) => seen.push(i) }
  }

  it('用户答复 → reason=user', async () => {
    const { seen, onDecide } = collect()
    let id = ''
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        id = r.id
        return true
      },
      log: silentLog,
      onDecide
    })
    const p = bridge.request(req())
    bridge.respond({ id, allowed: true })
    await expect(p).resolves.toBe(true)
    expect(seen).toEqual([expect.objectContaining({ allowed: true, reason: 'user' })])
  })

  it('超时 → reason=timeout', async () => {
    vi.useFakeTimers()
    try {
      const { seen, onDecide } = collect()
      const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 1000, onDecide })
      const p = bridge.request(req())
      vi.advanceTimersByTime(1001)
      await p
      expect(seen).toEqual([expect.objectContaining({ allowed: false, reason: 'timeout' })])
    } finally {
      vi.useRealTimers()
    }
  })

  it('推送失败 → reason=undeliverable', async () => {
    const { seen, onDecide } = collect()
    const bridge = createPlanApprovalBridge({ send: () => false, log: silentLog, onDecide })
    await bridge.request(req())
    expect(seen).toEqual([expect.objectContaining({ allowed: false, reason: 'undeliverable' })])
  })

  it('中止 → reason=aborted', async () => {
    const { seen, onDecide } = collect()
    const ac = new AbortController()
    const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 60_000, onDecide })
    const p = bridge.request(req(), { signal: ac.signal })
    ac.abort()
    await p
    expect(seen).toEqual([expect.objectContaining({ allowed: false, reason: 'aborted' })])
  })

  it('abortAll → 每个待决各打一次点（不重复、不遗漏）', async () => {
    const { seen, onDecide } = collect()
    const bridge = createPlanApprovalBridge({ send: () => true, log: silentLog, timeoutMs: 60_000, onDecide })
    const a = bridge.request(req({ agent: 'A' }))
    const b = bridge.request(req({ agent: 'B' }))
    bridge.abortAll('窗口关闭')
    await Promise.all([a, b])
    expect(seen).toHaveLength(2)
    expect(seen.every((s) => s.allowed === false && s.reason === '窗口关闭')).toBe(true)
  })

  it('已被用户答复过的项，abortAll 不再重复打点', async () => {
    const { seen, onDecide } = collect()
    let id = ''
    const bridge = createPlanApprovalBridge({
      send: (r) => {
        id = r.id
        return true
      },
      log: silentLog,
      timeoutMs: 60_000,
      onDecide
    })
    const p = bridge.request(req())
    bridge.respond({ id, allowed: true })
    await p
    bridge.abortAll('cleanup')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ allowed: true, reason: 'user' })
  })
})
