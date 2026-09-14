import { describe, expect, it } from 'vitest'
import { createGoalTools, type GoalCreator } from '@main/agent/tools/goal-tools'
import { GOAL_TEXT_MAX, type Goal } from '@shared/goal'

// plan12 ⑤：set_goal 工具的单测。工具层是纯逻辑（依赖倒置 —— setGoal 由注入方实现），
// 这里验三件事：参数校验带人话理由、注入调用拿到的 input 形状正确、返回文案说人话。
// 「目标真的落盘 + createdBy 署名」是组合根（main/ipc.ts onSetGoal）与 store 层的事，
// 由 store 的既有单测与门禁覆盖，这里不重复。

function makeGoal(patch: Partial<Goal> = {}): Goal {
  return {
    id: 'g-test',
    conversationId: 'c1',
    text: '测试目标',
    status: 'active',
    createdBy: '内核默认',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

/** 可编程假注入：记录收到的 input，返回固定形状的 Goal */
function fakeCreator(goal: Goal = makeGoal()): { deps: GoalCreator; calls: Array<{ text: string; doneWhen?: string }> } {
  const calls: Array<{ text: string; doneWhen?: string }> = []
  return {
    calls,
    deps: {
      setGoal: (input) => {
        calls.push(input)
        return { ...goal, text: input.text, ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}) }
      }
    }
  }
}

describe('set_goal 工具（plan12 ⑤）', () => {
  it('schema：名字 / 必填项 / 描述与待办划清界限', () => {
    const [tool] = createGoalTools(fakeCreator().deps)
    expect(tool.schema.name).toBe('set_goal')
    expect(tool.schema.parameters.required).toEqual(['text'])
    expect(tool.schema.description).toContain('update_todos')
  })

  it('正常登记：注入拿到 text，返回文案带上目标文本', async () => {
    const { deps, calls } = fakeCreator()
    const [tool] = createGoalTools(deps)
    const out = await tool.execute({ text: '把工作台做成每天都能用的东西' })
    expect(calls).toEqual([{ text: '把工作台做成每天都能用的东西' }])
    expect(out).toContain('把工作台做成每天都能用的东西')
    expect(out).toContain('已登记目标')
  })

  it('带完成判据：doneWhen 原样下传，文案里说明判据', async () => {
    const { deps, calls } = fakeCreator()
    const [tool] = createGoalTools(deps)
    const out = await tool.execute({ text: '目标', doneWhen: '全部批次收口且四道闸绿' })
    expect(calls[0]?.doneWhen).toBe('全部批次收口且四道闸绿')
    expect(out).toContain('完成判据：全部批次收口且四道闸绿')
  })

  it('空文本：带理由拒绝，且不惊动注入方', async () => {
    const { deps, calls } = fakeCreator()
    const [tool] = createGoalTools(deps)
    const out = await tool.execute({ text: '   ' })
    expect(String(out)).toContain('错误')
    expect(calls).toEqual([])
  })

  it(`超长（> ${GOAL_TEXT_MAX} 字）：带理由拒绝，且不惊动注入方（上限与 shared 同源，不许各写各的）`, async () => {
    const { deps, calls } = fakeCreator()
    const [tool] = createGoalTools(deps)
    const out = await tool.execute({ text: '长'.repeat(GOAL_TEXT_MAX + 1) })
    expect(String(out)).toContain(String(GOAL_TEXT_MAX))
    expect(calls).toEqual([])
  })

  it('text 不是字符串：当空处理，不抛异常', async () => {
    const { deps, calls } = fakeCreator()
    const [tool] = createGoalTools(deps)
    const out = await tool.execute({ text: 42 })
    expect(String(out)).toContain('错误')
    expect(calls).toEqual([])
  })
})
