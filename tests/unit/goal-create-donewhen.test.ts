// B0b 单测：renderer store.createGoal 第三个可选参 doneWhen 原样下发 window.api.createGoal。
// 不传时不带该字段（主进程按缺字段处理）；传了必须一字不改地下发 —— 前端不做任何截断或校验。
import { describe, expect, it, vi } from 'vitest'

async function loadStore(createGoalMock: ReturnType<typeof vi.fn>, listGoalsMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { api: { createGoal: createGoalMock, listGoals: listGoalsMock } })
  vi.resetModules()
  return import('../../src/renderer/src/store')
}

describe('store.createGoal doneWhen 透传（B0b）', () => {
  it('带判据：createGoal 下发的载荷里 doneWhen 一字不改', async () => {
    const createGoalMock = vi.fn(async () => ({ id: 'g9' }))
    const listGoalsMock = vi.fn(async () => [])
    const { useAppStore } = await loadStore(createGoalMock, listGoalsMock)
    await useAppStore.getState().createGoal('c1', '每天跑一次', '跑通且落盘才算')
    expect(createGoalMock).toHaveBeenCalledWith({
      conversationId: 'c1',
      text: '每天跑一次',
      doneWhen: '跑通且落盘才算'
    })
    expect(listGoalsMock).toHaveBeenCalledWith('c1')
    vi.unstubAllGlobals()
  })

  it('不带判据：载荷里没有 doneWhen 字段（不是空串占位）', async () => {
    const createGoalMock = vi.fn(async () => ({ id: 'g9' }))
    const listGoalsMock = vi.fn(async () => [])
    const { useAppStore } = await loadStore(createGoalMock, listGoalsMock)
    await useAppStore.getState().createGoal('c1', '每天跑一次')
    expect(createGoalMock).toHaveBeenCalledWith({ conversationId: 'c1', text: '每天跑一次' })
    vi.unstubAllGlobals()
  })
})
