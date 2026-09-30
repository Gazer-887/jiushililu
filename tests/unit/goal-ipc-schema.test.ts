import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { goalActionSchema, goalCreateSchema } from '@main/schemas'
import { GOAL_TEXT_MAX } from '@shared/goal'

/**
 * 目标 IPC 的**把关层**（plan12 §三 步 2 的出口「单测 + 类型收口」，2026-10-01 补）。
 *
 * 为什么又是"读源码"而不是跑行为：这四条 handler 跑在真主进程里，单测起不来，
 * 而真渲染门禁用的是隔离桩（**桩不过 zod**，见 `tests/unit/ui-prefs-ipc-schema.test.ts` 同一先例）——
 * 所以形状在这里退一档查 schema + handler 源码，挡"改着改着又漏掉"，不替代行为测试。
 * ⚠️ 它**不**等于"落盘语义测过了"：那半在 `goal-store.test.ts`（core）与 `goal-store.spec.ts`（真入口）。
 */

const IPC_SRC = readFileSync('src/main/ipc.ts', 'utf8')

describe('goalCreateSchema：正文与判据都限长，且身份由组合根定', () => {
  it('一条最小载荷过；空正文 / 空会话身份被拒（带形状错误，不是静默截断）', () => {
    expect(goalCreateSchema.safeParse({ conversationId: 'c1', text: '把目标通路做完' }).success).toBe(true)
    expect(goalCreateSchema.safeParse({ conversationId: 'c1', text: '' }).success).toBe(false)
    expect(goalCreateSchema.safeParse({ conversationId: '', text: 'x' }).success).toBe(false)
  })

  it('★ 上限与状态机**同一把尺**：schema 收得下的长度，`createGoal` 也必须收得下（两把尺错开就会出现"IPC 通过、存储抛错"）', () => {
    const at = '一'.repeat(GOAL_TEXT_MAX)
    const over = '一'.repeat(GOAL_TEXT_MAX + 1)
    expect(goalCreateSchema.safeParse({ conversationId: 'c1', text: at }).success).toBe(true)
    expect(goalCreateSchema.safeParse({ conversationId: 'c1', text: over }).success).toBe(false)
  })

  it('`doneWhen` 可选、超限拒', () => {
    expect(goalCreateSchema.safeParse({ conversationId: 'c1', text: 'x' }).success).toBe(true)
    expect(
      goalCreateSchema.safeParse({ conversationId: 'c1', text: 'x', doneWhen: '判'.repeat(201) }).success
    ).toBe(false)
  })

  it('★ 渲染端伪造 `createdBy` 进不来：zod 默认丢未知键，身份由 handler 写死', () => {
    const parsed = goalCreateSchema.parse({
      conversationId: 'c1',
      text: 'x',
      createdBy: '某个 Agent'
    } as never)
    expect('createdBy' in (parsed as Record<string, unknown>)).toBe(false)
    // 而 handler 里确实是固定串（不是把入参透传）——否则 Agent 能冒充用户建的
    expect(IPC_SRC).toMatch(/goalCreate[\s\S]{0,240}createdBy: 'user'/)
  })
})

describe('goalActionSchema：六种动作形状齐，非法动作进不来', () => {
  it('六种都在（状态机只管能不能，形状先放行）', () => {
    for (const action of ['pause', 'resume', 'complete', 'reopen', 'drop', 'edit'] as const) {
      expect(goalActionSchema.safeParse({ id: 'g1', action }).success).toBe(true)
    }
  })

  it('动作拼错 / 多传字段：形状当场拒', () => {
    expect(goalActionSchema.safeParse({ id: 'g1', action: 'cancel' }).success).toBe(false)
    expect(goalActionSchema.safeParse({ id: '', action: 'pause' }).success).toBe(false)
  })

  it('`edit` 的 patch 限长同 create', () => {
    expect(
      goalActionSchema.safeParse({ id: 'g1', action: 'edit', patch: { text: '编'.repeat(201) } }).success
    ).toBe(false)
    expect(goalActionSchema.safeParse({ id: 'g1', action: 'edit', patch: { text: '改成这样' } }).success).toBe(true)
  })
})

describe('四条 handler 都过这道闸（没有旁路）', () => {
  it.each(['goalList', 'goalCreate', 'goalAction', 'goalDelete'])(
    '%s 的 handler 存在且 200 字内走 friendlyParse',
    (channel) => {
      // 窗口必须**收在handler 自己那一截**：第一版写死 200 字，吃进了下一个 handler 的
      // `friendlyParse` ⇒ 旁路掉本条闸也照样绿（是变异 M7 把它打回原形的）
      const at = IPC_SRC.indexOf(`ipcMain.handle(IPC.${channel}`)
      expect(at, `找不到 IPC.${channel} 的 handler`).toBeGreaterThan(-1)
      const end = IPC_SRC.indexOf('\n  })', at)
      expect(end, `IPC.${channel} 的 handler 结构变了，窗口取不到 body`).toBeGreaterThan(at)
      const body = IPC_SRC.slice(at, end)
      expect(body, `IPC.${channel} 未走 friendlyParse`).toContain('friendlyParse')
    }
  )
})
