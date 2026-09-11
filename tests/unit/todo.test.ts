import { describe, expect, it } from 'vitest'
import { MAX_TODOS, normalizeTodos, statsLine, todoStats } from '@shared/todo'

// 待办清单的纯逻辑（plan7 批 D）。
// 重点在**归一化**：入参来自模型，给什么都可能 —— 脏数据绝不能流进界面。

describe('normalizeTodos', () => {
  it('正常清单原样通过', () => {
    const out = normalizeTodos([
      { text: '第一步', status: 'completed' },
      { text: '第二步', status: 'in_progress' }
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ text: '第一步', status: 'completed' })
    expect(out[1]?.status).toBe('in_progress')
  })

  it('非数组一律回空数组（模型偶尔吐字符串/对象）', () => {
    expect(normalizeTodos(null)).toEqual([])
    expect(normalizeTodos(undefined)).toEqual([])
    expect(normalizeTodos('第一步')).toEqual([])
    expect(normalizeTodos({ text: 'x' })).toEqual([])
  })

  it('缺 status 或状态不认识 → 按待处理（保住内容，只丢状态）', () => {
    const out = normalizeTodos([{ text: 'A' }, { text: 'B', status: 'doing' }, { text: 'C', status: 7 }])
    expect(out.map((t) => t.status)).toEqual(['pending', 'pending', 'pending'])
  })

  it('缺 text / text 全空白 → 丢弃该条', () => {
    const out = normalizeTodos([{ text: '' }, { text: '   ' }, { text: '有效' }, { status: 'pending' }, null])
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toBe('有效')
  })

  it('超长文本截断到 200 字', () => {
    const out = normalizeTodos([{ text: 'x'.repeat(500), status: 'pending' }])
    expect(out[0]?.text).toHaveLength(200)
  })

  it('超过上限的条目被截掉', () => {
    const many = Array.from({ length: MAX_TODOS + 20 }, (_, i) => ({
      text: `第 ${i} 项`,
      status: 'pending'
    }))
    expect(normalizeTodos(many)).toHaveLength(MAX_TODOS)
  })

  it('模型没给 id 时自动补，给了就沿用', () => {
    const out = normalizeTodos([{ text: 'A' }, { id: 'keep-me', text: 'B' }])
    expect(out[0]?.id).toBe('t1')
    expect(out[1]?.id).toBe('keep-me')
  })

  it('text 两端空白被裁掉', () => {
    expect(normalizeTodos([{ text: '  前后有空格  ' }])[0]?.text).toBe('前后有空格')
  })
})

describe('todoStats / statsLine', () => {
  it('按状态分类计数', () => {
    const s = todoStats([
      { id: '1', text: 'a', status: 'completed' },
      { id: '2', text: 'b', status: 'completed' },
      { id: '3', text: 'c', status: 'in_progress' },
      { id: '4', text: 'd', status: 'pending' }
    ])
    expect(s).toEqual({ total: 4, completed: 2, inProgress: 1, pending: 1 })
  })

  it('空清单计数全零', () => {
    expect(todoStats([])).toEqual({ total: 0, completed: 0, inProgress: 0, pending: 0 })
  })

  it('统计行是 DSH 那句格式', () => {
    expect(statsLine({ total: 9, completed: 7, inProgress: 1, pending: 1 })).toBe(
      '7 已完成 · 1 进行中 · 1 待处理'
    )
  })
})
