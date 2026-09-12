import { describe, expect, it } from 'vitest'
import {
  GOAL_TEXT_MAX,
  applyGoalAction,
  createGoal,
  normalizeGoals,
  openGoals,
  sortGoals,
  type Goal
} from '@shared/goal'

/**
 * 目标（plan12）—— 纯逻辑部分。
 *
 * 界面与落盘都建立在"状态机不会自己乱走"之上：非法转移必须**带着理由被拒**，
 * 否则界面会出现"点了没反应"或"状态自己变了"这两种最难查的怪象。
 */

const NOW = 1_700_000_000_000

const make = (text = '把工作台做成能用的东西'): Goal => {
  const r = createGoal({
    id: 'g1',
    conversationId: 'c1',
    text,
    createdBy: 'user',
    now: NOW
  })
  if (!r.ok) throw new Error('前置不成立：' + r.reason)
  return r.goal
}

describe('建目标', () => {
  it('正常建：状态是 active，时间戳与创建者都落上', () => {
    const g = make()
    expect(g.status).toBe('active')
    expect(g.createdAt).toBe(NOW)
    expect(g.updatedAt).toBe(NOW)
    expect(g.createdBy).toBe('user')
    expect(g.conversationId).toBe('c1')
  })

  it('空文本 / 全空白 → 拒绝（界面上会变成一条没意义的空行）', () => {
    expect(createGoal({ id: 'x', conversationId: 'c1', text: '   ', createdBy: 'user', now: NOW }).ok).toBe(false)
    expect(createGoal({ id: 'x', conversationId: 'c1', text: '', createdBy: 'user', now: NOW }).ok).toBe(false)
  })

  it('超长 → 拒绝（目标是"一句话意图"，不是任务书）', () => {
    const r = createGoal({
      id: 'x',
      conversationId: 'c1',
      text: '目'.repeat(GOAL_TEXT_MAX + 1),
      createdBy: 'user',
      now: NOW
    })
    expect(r.ok).toBe(false)
  })

  it('必须属于一条会话（没有归属的目标没法存在任何地方）', () => {
    expect(createGoal({ id: 'x', conversationId: '  ', text: '做点事', createdBy: 'user', now: NOW }).ok).toBe(false)
  })

  it('首尾空白会被去掉（用户多打了个空格不该原样存进去）', () => {
    const r = createGoal({ id: 'x', conversationId: 'c1', text: '  做点事  ', createdBy: 'user', now: NOW })
    expect(r.ok && r.goal.text).toBe('做点事')
  })

  it('给了判据就带上，没给就不留空串字段', () => {
    const withWhen = createGoal({
      id: 'x',
      conversationId: 'c1',
      text: '做点事',
      doneWhen: ' 测试全绿 ',
      createdBy: 'user',
      now: NOW
    })
    expect(withWhen.ok && withWhen.goal.doneWhen).toBe('测试全绿')
    expect('doneWhen' in make()).toBe(false)
  })
})

describe('状态机：合法转移', () => {
  it('active → paused → active（暂停/继续）', () => {
    const paused = applyGoalAction(make(), 'pause', NOW + 1)
    expect(paused.ok && paused.goal.status).toBe('paused')
    const back = paused.ok ? applyGoalAction(paused.goal, 'resume', NOW + 2) : null
    expect(back?.ok && back.goal.status).toBe('active')
  })

  it('active / paused → done（完成）', () => {
    expect(applyGoalAction(make(), 'complete', NOW).ok).toBe(true)
    const paused = applyGoalAction(make(), 'pause', NOW)
    expect(paused.ok ? applyGoalAction(paused.goal, 'complete', NOW).ok : false).toBe(true)
  })

  it('done → active（重开：阶段性的目标很常见）', () => {
    const done = applyGoalAction(make(), 'complete', NOW)
    const again = done.ok ? applyGoalAction(done.goal, 'reopen', NOW) : null
    expect(again?.ok && again.goal.status).toBe('active')
  })

  it('编辑只改文字/判据，**不动状态**', () => {
    const paused = applyGoalAction(make(), 'pause', NOW)
    if (!paused.ok) throw new Error('前置不成立')
    const edited = applyGoalAction(paused.goal, 'edit', NOW + 5, { text: '改成这样', doneWhen: '这样算做完' })
    expect(edited.ok && edited.goal.text).toBe('改成这样')
    expect(edited.ok && edited.goal.doneWhen).toBe('这样算做完')
    expect(edited.ok && edited.goal.status).toBe('paused')
  })

  it('每次动作都刷新 `updatedAt`（界面据此排"最近动过"）', () => {
    const r = applyGoalAction(make(), 'pause', NOW + 99)
    expect(r.ok && r.goal.updatedAt).toBe(NOW + 99)
  })
})

describe('状态机：非法转移必须**带着理由**被拒', () => {
  it('对已完成的目标再 complete → 拒绝，并告诉用户要先重开', () => {
    const done = applyGoalAction(make(), 'complete', NOW)
    if (!done.ok) throw new Error('前置不成立')
    const again = applyGoalAction(done.goal, 'complete', NOW)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain('重开')
  })

  it('对进行中的目标 resume → 拒绝（它没在暂停）', () => {
    const r = applyGoalAction(make(), 'resume', NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('暂停')
  })

  it('对已完成的目标 pause → 拒绝', () => {
    const done = applyGoalAction(make(), 'complete', NOW)
    if (!done.ok) throw new Error('前置不成立')
    expect(applyGoalAction(done.goal, 'pause', NOW).ok).toBe(false)
  })

  it('编辑成空文本 → 拒绝（不许把目标改没）', () => {
    const r = applyGoalAction(make(), 'edit', NOW, { text: '   ' })
    expect(r.ok).toBe(false)
  })
})

describe('展示层：排序与"还在进行"的筛选', () => {
  const g = (id: string, status: Goal['status'], createdAt: number): Goal => ({
    id,
    conversationId: 'c1',
    text: id,
    status,
    createdBy: 'user',
    createdAt,
    updatedAt: createdAt
  })

  it('进行中 → 暂停 → 其它；同组内新的在前', () => {
    const sorted = sortGoals([
      g('done', 'done', 5),
      g('pausedOld', 'paused', 1),
      g('activeNew', 'active', 9),
      g('activeOld', 'active', 2),
      g('dropped', 'dropped', 7),
      g('pausedNew', 'paused', 8)
    ])
    expect(sorted.map((x) => x.id)).toEqual(['activeNew', 'activeOld', 'pausedNew', 'pausedOld', 'done', 'dropped'])
  })

  it('`openGoals` 只留进行中与暂停（完成/放弃的进历史，不占输入框上方的位置）', () => {
    const open = openGoals([g('a', 'active', 3), g('p', 'paused', 2), g('d', 'done', 1), g('x', 'dropped', 0)])
    expect(open.map((x) => x.id)).toEqual(['a', 'p'])
  })
})

describe('读盘容错：坏数据丢掉并计数，绝不整表崩', () => {
  it('整份不是数组 → 全丢并计数', () => {
    expect(normalizeGoals({ nope: 1 })).toEqual({ goals: [], dropped: 1 })
    expect(normalizeGoals(null)).toEqual({ goals: [], dropped: 1 })
  })

  it('逐条校验：缺字段 / 状态非法 / id 重复 / 时间不是数字 都被丢掉，好的留下', () => {
    const res = normalizeGoals([
      { id: 'ok1', conversationId: 'c1', text: '好的', status: 'active', createdBy: 'user', createdAt: 1, updatedAt: 2 },
      { id: 'ok1', conversationId: 'c1', text: '重复 id', status: 'active', createdBy: 'user', createdAt: 1 },
      { id: '', conversationId: 'c1', text: '缺 id', status: 'active' },
      { id: 'noText', conversationId: 'c1', text: '   ', status: 'active' },
      { id: 'badStatus', conversationId: 'c1', text: '状态乱写', status: 'whatever' },
      { id: 'noConv', conversationId: '', text: '没归属', status: 'active' },
      null,
      'string',
      { id: 'ok2', conversationId: 'c1', text: '时间坏掉', status: 'paused', createdAt: 'NaN' }
    ])
    expect(res.goals.map((x) => x.id)).toEqual(['ok1', 'ok2'])
    // 丢的是：重复 id、空 id、空文本、非法状态、无归属、null、字符串 —— 共 7 条；
    // 时间坏掉那条**不丢**（见下一条：宁可排序不准，也别丢用户的目标）
    expect(res.dropped).toBe(7)
  })

  it('时间坏掉不丢整条，退化成 0（宁可排序不准，也别丢用户的目标）', () => {
    const res = normalizeGoals([{ id: 'g', conversationId: 'c1', text: 'x', status: 'active', createdAt: 'NaN' }])
    expect(res.goals).toHaveLength(1)
    expect(res.goals[0].createdAt).toBe(0)
    expect(res.goals[0].updatedAt).toBe(0)
  })

  it('`createdBy` 缺失时退回 `user`（历史数据没有这个字段）', () => {
    const res = normalizeGoals([{ id: 'g', conversationId: 'c1', text: 'x', status: 'active', createdAt: 1 }])
    expect(res.goals[0].createdBy).toBe('user')
  })

  it('空数组 → 什么都不丢（别把"没有目标"报成"数据坏了"）', () => {
    expect(normalizeGoals([])).toEqual({ goals: [], dropped: 0 })
  })
})
