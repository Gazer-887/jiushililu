import { afterAll, describe, expect, it, vi } from 'vitest'
import { createConfirmBridge } from '@main/confirm'
import { createSystemToolsWithConfirm, createSystemTools } from '@main/agent/tools/system-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 危险操作逐次确认（plan8 R5）
//
// 这组测试盯的是一个安全属性：**没人答复时必须拒绝**。
// 任何"等不到答复就放行"的实现都等于没有确认机制 —— 因为崩溃/超时是常态。
// 默认超时 60s 对测试太长，故桥支持注入短超时。

const req = (over = {}) => ({
  tool: 'run_command',
  detail: 'rm -rf build',
  agent: '内核默认',
  where: 'D:/ws',
  ...over
})

const silentLog = (): void => {}

describe('确认桥：无人应答 = 拒绝（安全默认）', () => {
  it('超时未答复 → 拒绝（不是放行）', async () => {
    vi.useFakeTimers()
    try {
      const bridge = createConfirmBridge({ send: () => true, log: silentLog, timeoutMs: 1000 })
      const p = bridge.ask(req())
      vi.advanceTimersByTime(1001)
      await expect(p).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('推不到界面（无窗口）→ 立即拒绝，不留待决', async () => {
    const bridge = createConfirmBridge({ send: () => false, log: silentLog })
    await expect(bridge.ask(req())).resolves.toBe(false)
    expect(bridge.hasPending()).toBe(false)
  })

  it('窗口全关时 abortAll → 待决请求按拒绝处理', async () => {
    const bridge = createConfirmBridge({ send: () => true, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(req())
    expect(bridge.hasPending()).toBe(true)
    bridge.abortAll('窗口已全部关闭')
    await expect(p).resolves.toBe(false)
    expect(bridge.hasPending()).toBe(false)
  })
})

describe('确认桥：答复配对', () => {
  it('用户允许 → 返回 true', async () => {
    let captured: { id: string } | null = null
    const bridge = createConfirmBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.ask(req())
    expect(captured).not.toBeNull()
    expect(bridge.respond({ id: captured!.id, allowed: true })).toBe(true)
    await expect(p).resolves.toBe(true)
  })

  it('用户拒绝 → 返回 false', async () => {
    let captured: { id: string } | null = null
    const bridge = createConfirmBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.ask(req())
    expect(bridge.respond({ id: captured!.id, allowed: false })).toBe(true)
    await expect(p).resolves.toBe(false)
  })

  it('不认识的 id 被忽略（过期/伪造响应不会误配新请求）', async () => {
    const bridge = createConfirmBridge({ send: () => true, log: silentLog, timeoutMs: 60_000 })
    const p = bridge.ask(req())
    expect(bridge.respond({ id: 'forged-id', allowed: true })).toBe(false)
    expect(bridge.hasPending()).toBe(true) // 原请求仍在等
    bridge.abortAll('cleanup')
    await expect(p).resolves.toBe(false)
  })

  it('重复答复同一 id → 第二次被忽略（不会二次改写结果）', async () => {
    let captured: { id: string } | null = null
    const bridge = createConfirmBridge({
      send: (r) => {
        captured = r
        return true
      },
      log: silentLog
    })
    const p = bridge.ask(req())
    expect(bridge.respond({ id: captured!.id, allowed: true })).toBe(true)
    expect(bridge.respond({ id: captured!.id, allowed: false })).toBe(false)
    await expect(p).resolves.toBe(true) // 仍是第一次的答案
  })

  it('两次请求拿到不同的 id', () => {
    const ids: string[] = []
    const bridge = createConfirmBridge({
      send: (r) => {
        ids.push(r.id)
        return true
      },
      log: silentLog,
      timeoutMs: 60_000
    })
    void bridge.ask(req())
    void bridge.ask(req())
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    bridge.abortAll('cleanup')
  })
})

describe('run_command 的确认接缝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-cmd-'))
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  })

  const cmdTool = (tools: ReturnType<typeof createSystemTools>): (typeof tools)[number] =>
    tools.find((t) => t.schema.name === 'run_command')!

  it('用户拒绝 → 命令不执行，返回可读的错误文本（模型能据此改道）', async () => {
    let asked = ''
    const tools = createSystemToolsWithConfirm(dir, async (command) => {
      asked = command
      return false
    })
    const out = await cmdTool(tools).execute({ command: 'echo 不该执行' })

    expect(asked).toBe('echo 不该执行')
    expect(out).toContain('用户拒绝执行')
    expect(out).not.toContain('不该执行\n') // 确实没跑（否则会有 stdout 段）
  })

  it('用户允许 → 命令正常执行并回显输出', async () => {
    const tools = createSystemToolsWithConfirm(dir, async () => true)
    const out = await cmdTool(tools).execute({ command: 'echo hello-from-confirm' })
    expect(out).toContain('hello-from-confirm')
  })

  it('空 command 直接报错，**不惊动用户**（没必要为无效输入弹窗）', async () => {
    let calls = 0
    const tools = createSystemToolsWithConfirm(dir, async () => {
      calls++
      return true
    })
    const out = await cmdTool(tools).execute({ command: '   ' })
    expect(out).toContain('command 不能为空')
    expect(calls).toBe(0)
  })

  it('不注入确认时保持旧行为（CLI/单测场景不受影响）', async () => {
    const tools = createSystemTools(dir)
    const out = await cmdTool(tools).execute({ command: 'echo no-confirm-needed' })
    expect(out).toContain('no-confirm-needed')
  })
})
