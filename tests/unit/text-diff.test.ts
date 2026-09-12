// 文本差异（plan13 批 B）—— 单测
//
// 这一份测的重点不是"diff 算法对不对"（那是 jsdiff 的事），
// 而是**我们这一层会不会把行号/块序号算错** —— 因为界面上的"拒绝第 N 处"
// 直接依赖它，错了就是"点了第 2 处、改了第 3 处"，不报错、只改错。

import { describe, expect, it } from 'vitest'
import {
  canRevertHunks,
  computeHunks,
  MAX_HUNKS,
  summarizeDiff,
  type DiffLine
} from '@shared/text-diff'

const text = (...lines: string[]): string => lines.join('\n')
const byNo = (lines: DiffLine[]): string[] =>
  lines.map((l) => `${l.type}@${l.oldNo ?? '-'}/${l.newNo ?? '-'}`)

describe('computeHunks —— 块与行号', () => {
  it('单处改动：一个块、序号为 1、行列计数正确', () => {
    const r = computeHunks(text('a', 'b', 'c'), text('a', 'B', 'c'))
    expect(r.hunks).toHaveLength(1)
    expect(r.hunks[0]!.index).toBe(1)
    expect(r.added).toBe(1)
    expect(r.removed).toBe(1)
    expect(r.identical).toBe(false)
  })

  it('**改前的行号从 1 开始，删掉的行号不能串**', () => {
    const r = computeHunks(text('a', 'b', 'c'), text('a', 'B', 'c'))
    // 上下文 a=1、删 b=2、增 B=2、上下文 c=3
    expect(byNo(r.hunks[0]!.lines)).toEqual([
      'context@1/1',
      'del@2/-',
      'add@-/2',
      'context@3/3'
    ])
  })

  it('改动做了增行：后面上下文行的**新旧行号必须错开**（最容易算错的地方）', () => {
    const r = computeHunks(text('a', 'b', 'c'), text('a', 'b', 'x', 'y', 'c'))
    expect(byNo(r.hunks[0]!.lines)).toEqual([
      'context@1/1',
      'context@2/2',
      'add@-/3',
      'add@-/4',
      'context@3/5'
    ])
  })

  it('两处相隔很远的改动 → **两个块**，且后面那块的行号接着真实行数走', () => {
    const before = text('L1', 'X', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'Y', 'L12')
    const after = text('L1', 'X!', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'Y!', 'L12')
    const r = computeHunks(before, after)
    expect(r.hunks.map((h) => h.index)).toEqual([1, 2])
    // 第 2 块的起始行 = 改动行(11) − 上下文(3) = 8。
    // **这一条就是在防"从 1 重数"那个 bug**：写错的话这里会是 1。
    expect(r.hunks[1]!.oldStart).toBe(8)
    // 两块不许重叠：第 1 块结束（oldStart+oldLines）要在第 2 块开始之前
    const h1 = r.hunks[0]!
    expect(h1.oldStart + h1.oldLines).toBeLessThanOrEqual(r.hunks[1]!.oldStart)
    expect(r.added).toBe(2)
    expect(r.removed).toBe(2)
  })

  it('内容相同 → 无块、identical', () => {
    const r = computeHunks(text('a', 'b'), text('a', 'b'))
    expect(r.hunks).toEqual([])
    expect(r.identical).toBe(true)
    expect(summarizeDiff(r)).toBe('无改动')
  })

  it('两侧都空 → 无块（空文件不是"有改动"）', () => {
    expect(computeHunks('', '').identical).toBe(true)
  })

  it('改前为空（新建文件）→ 全是新增行', () => {
    const r = computeHunks('', text('x', 'y'))
    expect(r.added).toBe(2)
    expect(r.removed).toBe(0)
    expect(r.hunks[0]!.lines.every((l) => l.type === 'add')).toBe(true)
  })

  it('改后为空（文件被删）→ 全是删除行', () => {
    const r = computeHunks(text('x', 'y'), '')
    expect(r.removed).toBe(2)
    expect(r.added).toBe(0)
    expect(r.hunks[0]!.lines.every((l) => l.type === 'del')).toBe(true)
  })

  it('**末行没有换行符时，行号不许错位**（jsdiff 会插一行 `\\ No newline` 标注）', () => {
    const r = computeHunks(text('a', 'b'), text('a', 'B'))
    expect(byNo(r.hunks[0]!.lines)).toEqual(['context@1/1', 'del@2/-', 'add@-/2'])
    // 标注行不能被当成内容塞进来
    expect(r.hunks[0]!.lines.some((l) => l.text.includes('No newline'))).toBe(false)
  })

  it('每块自带 added/removed（列表上要直接显示"＋3 −1"）', () => {
    const r = computeHunks(text('a', 'b'), text('a', 'b1', 'b2', 'b3'))
    expect(r.hunks[0]!.added).toBe(3)
    expect(r.hunks[0]!.removed).toBe(1)
  })

  it('摘要文案：只有增 / 只有删 / 都有', () => {
    expect(summarizeDiff(computeHunks('', 'a'))).toBe('＋1')
    expect(summarizeDiff(computeHunks('a', ''))).toBe('−1')
    expect(summarizeDiff(computeHunks('a', 'b'))).toBe('＋1 −1')
  })
})

describe('computeHunks —— 渲染预算（防把面板卡死）', () => {
  /** 造 n 处互相隔开的改动（间隔 > 2×上下文行数，所以必然是 n 个块） */
  const many = (n: number): { before: string; after: string } => {
    const b: string[] = []
    const a: string[] = []
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 10; j++) {
        b.push(`ctx ${i}-${j}`)
        a.push(`ctx ${i}-${j}`)
      }
      b.push(`old ${i}`)
      a.push(`new ${i}`)
    }
    return { before: b.join('\n'), after: a.join('\n') }
  }

  it(`块数超上限（>${MAX_HUNKS}）时**截断并如实标记**，不是静默少给`, () => {
    const { before, after } = many(MAX_HUNKS + 30)
    const r = computeHunks(before, after)
    expect(r.truncated).toBe(true)
    expect(r.hunks).toHaveLength(MAX_HUNKS)
    // "共 N 处、只显示前 M 处"这句文案靠它 —— 两个数字缺一不可
    expect(r.totalHunks).toBe(MAX_HUNKS + 30)
  })

  it('未超上限时**不许**误标截断（否则界面会白说一句"没显示全"）', () => {
    const { before, after } = many(3)
    const r = computeHunks(before, after)
    expect(r.truncated).toBe(false)
    expect(r.hunks).toHaveLength(3)
    expect(r.totalHunks).toBe(3)
  })

  it('截断后**仍然**统计全部改动的加减行数（用户要知道总规模，不能给截断后的假数字）', () => {
    const { before, after } = many(MAX_HUNKS + 30)
    const r = computeHunks(before, after)
    expect(r.added).toBe(MAX_HUNKS + 30)
    expect(r.removed).toBe(MAX_HUNKS + 30)
  })

  it('顺序敏感：截断时**前 200 块照旧**（index 连续、内容不错位）', () => {
    const { before, after } = many(MAX_HUNKS + 30)
    const r = computeHunks(before, after)
    expect(r.hunks[0]!.index).toBe(1)
    expect(r.hunks[MAX_HUNKS - 1]!.index).toBe(MAX_HUNKS)
    // 第 1 块的内容必须是第 0 处改动（old 0 / new 0），错位的话这里立刻红
    const texts = r.hunks[0]!.lines.map((l) => l.text)
    expect(texts).toContain('old 0')
    expect(texts).toContain('new 0')
  })
})

describe('canRevertHunks —— 什么时候**不许**逐块退回', () => {
  const base = { truncated: false, kind: 'modified' as const, hasBefore: true, hasAfter: true }

  it('正常情形：完整原文的 modified 文件 → 可以逐块', () => {
    expect(canRevertHunks(base)).toBe(true)
  })

  it('**created 文件不给逐块**：它没有"改前那几行"可还原，只能整份退回（删除）', () => {
    expect(canRevertHunks({ ...base, kind: 'created' })).toBe(false)
  })

  it('**文本被截断时不给逐块**：拿半个文件去写盘 = 把大文件砍掉（数据丢失）', () => {
    expect(canRevertHunks({ ...base, truncated: true })).toBe(false)
  })

  it('两侧缺任一侧（快照丢了 / 文件已被删）→ 不给逐块', () => {
    expect(canRevertHunks({ ...base, hasBefore: false })).toBe(false)
    expect(canRevertHunks({ ...base, hasAfter: false })).toBe(false)
  })
})
