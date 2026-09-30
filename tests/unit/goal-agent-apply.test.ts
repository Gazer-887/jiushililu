import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Goal } from '@shared/goal'

/**
 * 内核自建目标的**渲染端归属**（plan12 §四 验收 3「并发不串」，2026-10-01 补）。
 *
 * 为什么原来测不到：`goal:changed` 是**跨会话广播**的推送，而渲染端只有一份 `goals` 视图 ——
 * 只要 `applyAgentGoal` 少比一次 `conversationId`，B 会话里 Agent 建的目标就会出现在你正看着的 A 会话上。
 * 这类"界面凭空多一条"没有一道闸会红：单测层原先没人导入过这个 reducer，门禁的 `goal:list` 又是单会话桩。
 *
 * ⚠️ 这里测的是**分流**（哪条会话的账落进哪条会话的视图），不是"面板怎么排" ——
 * 面板过滤（完成后从进行中消失）见门禁断言，落盘归属见 `goal-store.test.ts`。三段是三层。
 */

const fakeGoals: Record<string, Goal[]> = {}

const fakeApi = {
  listGoals: vi.fn(async (conversationId: string) => structuredClone(fakeGoals[conversationId] ?? [])),
  createGoal: vi.fn(async (input: { conversationId: string; text: string }) => {
    const g = goal(input.conversationId, `g-${input.text}`, input.text)
    ;(fakeGoals[input.conversationId] ??= []).push(g)
    return g
  }),
  actOnGoal: vi.fn(async (id: string, action: string) => {
    for (const list of Object.values(fakeGoals)) {
      const hit = list.find((g) => g.id === id)
      if (!hit) continue
      if (action === 'complete') hit.status = 'done'
      if (action === 'pause') hit.status = 'paused'
      return structuredClone(hit)
    }
    throw new Error('该目标不存在（可能已被删除）')
  }),
  deleteGoal: vi.fn(async () => undefined)
}

vi.stubGlobal('window', { api: fakeApi })

// eslint-disable-next-line import/first -- 必须先立好 window 假桥（store 不在模块加载期碰 window，但顺序写对更稳）
import { useAppStore } from '../../src/renderer/src/store'

function goal(conversationId: string, id: string, text: string, status: Goal['status'] = 'active'): Goal {
  const now = Date.parse('2026-10-01T00:00:00Z')
  return {
    id,
    conversationId,
    text,
    status,
    createdBy: '内核默认',
    createdAt: now,
    updatedAt: now
  }
}

beforeEach(() => {
  for (const k of Object.keys(fakeGoals)) delete fakeGoals[k]
  fakeApi.listGoals.mockClear()
  fakeApi.actOnGoal.mockClear()
  useAppStore.setState({ activeId: 'A', goals: [] })
})

describe('applyAgentGoal：Agent 自建的目标只能落进它自己那条会话', () => {
  it('收到**别的会话**的目标 ⇒ 当前视图一条不多（这就是"串台"的本体）', () => {
    useAppStore.getState().applyAgentGoal(goal('B', 'g-B1', 'B 会话里 Agent 定的长期意图'))
    expect(useAppStore.getState().goals).toEqual([])
  })

  it('收到**当前会话**的目标 ⇒ 出现在视图里', () => {
    useAppStore.getState().applyAgentGoal(goal('A', 'g-A1', 'A 的长期意图'))
    expect(useAppStore.getState().goals.map((g) => g.id)).toEqual(['g-A1'])
  })

  it('两条会话各自的事件交替到达 ⇒ 各自的账互不污染（B 的永远进不了 A 的视图）', () => {
    const s = useAppStore.getState()
    s.applyAgentGoal(goal('A', 'g-A1', 'A1'))
    s.applyAgentGoal(goal('B', 'g-B1', 'B1'))
    s.applyAgentGoal(goal('A', 'g-A2', 'A2'))
    const ids = useAppStore.getState().goals.map((g) => g.id)
    expect(ids.sort()).toEqual(['g-A1', 'g-A2'])
    expect(JSON.stringify(useAppStore.getState().goals)).not.toContain('B1')
  })

  it('没有活动会话（新建页）⇒ 不许把目标挂到"下一条打开的会话"头上', () => {
    useAppStore.setState({ activeId: null })
    useAppStore.getState().applyAgentGoal(goal('A', 'g-A1', 'A 的意图'))
    expect(useAppStore.getState().goals).toEqual([])
  })

  it('同一 id 重复推送 ⇒ 只有一条（幂等：重连补发不该在界面上摆两根）', () => {
    const g = goal('A', 'g-dup', '重复到达')
    useAppStore.getState().applyAgentGoal(g)
    useAppStore.getState().applyAgentGoal(g)
    expect(useAppStore.getState().goals.map((x) => x.id)).toEqual(['g-dup'])
  })

  it('切会话后重拉：`loadGoals` 只装那条会话的（旧会话的残影必须被换掉）', async () => {
    fakeGoals.A = [goal('A', 'g-A1', 'A1')]
    fakeGoals.B = [goal('B', 'g-B1', 'B1'), goal('B', 'g-B2', 'B2')]

    await useAppStore.getState().loadGoals('A')
    expect(useAppStore.getState().goals.map((g) => g.id)).toEqual(['g-A1'])

    await useAppStore.getState().loadGoals('B')
    const bIds = useAppStore.getState().goals.map((g) => g.id)
    expect(bIds.sort()).toEqual(['g-B1', 'g-B2'])
    expect(bIds).not.toContain('g-A1')
  })

  it('点「完成」后重拉的是当前会话 ⇒ 状态更新落回自己那条，不会把别的会话洗成空', async () => {
    fakeGoals.A = [goal('A', 'g-A1', 'A1')]
    fakeGoals.B = [goal('B', 'g-B1', 'B1')]
    useAppStore.setState({ activeId: 'A' })
    await useAppStore.getState().loadGoals('A')

    await useAppStore.getState().actOnGoal('g-A1', 'complete')
    expect(fakeApi.actOnGoal).toHaveBeenCalledWith('g-A1', 'complete', undefined)
    expect(useAppStore.getState().goals.find((g) => g.id === 'g-A1')?.status).toBe('done')
    // 判据是"**从不拉别的会话**"，不是"只拉一次"：显式 loadGoals('A') 一次 + actOnGoal 之后重拉一次 = 两次，
    // 两次都必须是 A（第一版断言写成 `toEqual(['A'])` 是我数错了调用次数 —— 计数类断言要按调用点列全）。
    const called = fakeApi.listGoals.mock.calls.map((c) => c[0])
    expect(called).toEqual(['A', 'A'])
    expect(called).not.toContain('B')
  })
})
