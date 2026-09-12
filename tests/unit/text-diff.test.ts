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
  MAX_TOTAL_LINES,
  revertHunk,
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
    // ⚠️ 先把**前提**钉住（审查指出）：哪天 jsdiff 不再插那个标注行，
    //    下面那条"没有标注行"就变成恒真的空断言，而没人会知道。
    expect(r.rawHunks[0]!.lines).toContain('\\ No newline at end of file')
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

// ── 退回一处改动（plan13 批 B · B4）─────────────────────────────
//
// 这组是整个 B4 的命门：**算错了不会报错，只会把文件改坏**。
// 所以判据一律落在"退完之后文本**具体**长什么样"，而不是"返回了 true"。

/** 造一对"两处相隔很远"的文本（第 2 行和第 15 行各有一处改动） */
function pair(): { before: string; after: string } {
  const b: string[] = []
  const a: string[] = []
  for (let i = 1; i <= 20; i++) {
    if (i === 2) {
      b.push('const x = 1')
      a.push('const x = 42')
    } else if (i === 15) {
      b.push('const y = 2')
      a.push('const y = 3')
    } else {
      b.push(`line ${i}`)
      a.push(`line ${i}`)
    }
  }
  return { before: b.join('\n'), after: a.join('\n') }
}

describe('revertHunk —— 退回「第 N 处」', () => {
  it('原生块与展示块**下标对齐**（对不齐就会"点了第 2 处、改掉第 N 处"）', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    expect(d.hunks).toHaveLength(2)
    expect(d.rawHunks).toHaveLength(2)
    // ⚠️ 判据必须是**顺序全等**，不能是"包含"（审查指出原写法是自证式：
    //    把所有块都配到 rawHunks[0]、或块内行序被打乱，`toContain` 照样绿）。
    for (let i = 0; i < d.hunks.length; i++) {
      const raw = d.rawHunks[i]!.lines.filter((l) => !l.startsWith('\\'))
      const shown = d.hunks[i]!.lines.map(
        (l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text
      )
      expect(shown).toEqual(raw) // 条数 + 顺序 + 内容
      expect(d.hunks[i]!.index).toBe(i + 1)
      expect(d.hunks[i]!.oldStart).toBe(d.rawHunks[i]!.oldStart) // 两套确实指同一处
      expect(d.hunks[i]!.newStart).toBe(d.rawHunks[i]!.newStart)
    }
  })

  it('退第 1 处 → **第 1 处还原、第 2 处原样保留**（最容易做错的一条）', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('const x = 1') // 第 1 处：回来了
    expect(r.text).not.toContain('const x = 42')
    expect(r.text).toContain('const y = 3') // 第 2 处：不许被顺手改掉
  })

  it('退第 2 处 → 第 1 处保留', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('const x = 42') // 第 1 处：保留
    expect(r.text).toContain('const y = 2') // 第 2 处：回来了
    expect(r.text).not.toContain('const y = 3')
  })

  it('**退完之后重算差异，块数应当少一处**（退回真的发生了，不是幻觉）', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const after2 = computeHunks(before, r.text)
    expect(after2.hunks).toHaveLength(1)
    expect(after2.hunks[0]!.lines.map((l) => l.text)).toContain('const y = 2')
  })

  it('**一处一处退完 → 回到改前的原文**（往返闭合）', () => {
    const { before, after } = pair()
    const d1 = computeHunks(before, after)
    const r1 = revertHunk(after, d1, 1)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    // 退回之后**必须重算**再退下一处 —— 块序号是相对当前差异的
    const d2 = computeHunks(before, r1.text)
    const r2 = revertHunk(r1.text, d2, 1)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.text).toBe(before)
  })

  it('序号越界 → no-such-hunk（**不许**默不作声改成别处）', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    for (const bad of [0, -1, 3, 99]) {
      const r = revertHunk(after, d, bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('no-such-hunk')
    }
  })

  it('**同一处连退两次 → 第二次失败**（内容已经对不上了，不许硬塞）', () => {
    const { before, after } = pair()
    const d1 = computeHunks(before, after)
    const r1 = revertHunk(after, d1, 1)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    // 再拿**同一份**差异退第 1 处：`const x = 42` 已经不在了 → applyPatch 找不到 → 拒绝
    const r2 = revertHunk(r1.text, d1, 1)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('apply-failed')
  })

  it('拿旧差异退**另一处**改动 → 仍然退得动（两块互不重叠，这是稳健而不是漏洞）', () => {
    const { before, after } = pair()
    const d1 = computeHunks(before, after)
    const r1 = revertHunk(after, d1, 1)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    // 第 2 处那一段**一个字都没被动过**，所以拿旧差异照样对得上 ——
    // applyPatch 会真去校验上下文行，对得上才写：这正是我们要的安全网。
    const r2 = revertHunk(r1.text, d1, 2)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.text).toBe(before)
  })

  it('**当前文本与差异对不上时拒绝**（apply-failed，而不是硬塞进去）', () => {
    const { before, after } = pair()
    const d = computeHunks(before, after)
    const r = revertHunk('完全不相干的一份文本\n第二行\n第三行', d, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('apply-failed')
  })

  it('没有差异时任何序号都退不了', () => {
    const same = text('a', 'b')
    const d = computeHunks(same, same)
    expect(d.identical).toBe(true)
    expect(revertHunk(same, d, 1).ok).toBe(false)
  })

  it('纯新增的一处 → 退回 = 把那几行删掉', () => {
    const before = text('a', 'b')
    const after = text('a', '新增一', '新增二', 'b')
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe(before)
  })

  it('纯删除的一处 → 退回 = 把那几行放回来', () => {
    const before = text('a', '要删的', 'b')
    const after = text('a', 'b')
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe(before)
  })

  it('**末行没有换行符时，退回来的文本也必须没有**（这正是原生块非留不可的原因）', () => {
    const before = 'a\nb' // 末行没有换行
    const after = 'a\nB'
    const d = computeHunks(before, after)
    const r = revertHunk(after, d, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('a\nb') // 不许变成 'a\nb\n'
  })

  it('大文件截断时，原生块与展示块**同步截断**（下标不许错位）', () => {    const b: string[] = []
    const a: string[] = []
    for (let i = 0; i < MAX_HUNKS + 20; i++) {
      for (let j = 0; j < 10; j++) {
        b.push(`ctx ${i}-${j}`)
        a.push(`ctx ${i}-${j}`)
      }
      b.push(`old ${i}`)
      a.push(`new ${i}`)
    }
    const d = computeHunks(b.join('\n'), a.join('\n'))
    expect(d.truncated).toBe(true)
    expect(d.rawHunks).toHaveLength(d.hunks.length)
    // 最后显示的那一块，两边必须指同一处改动
    const last = d.hunks.length - 1
    const rawTexts = d.rawHunks[last]!.lines.map((l) => l.slice(1))
    for (const t of d.hunks[last]!.lines.map((l) => l.text)) expect(rawTexts).toContain(t)
  })
})

// ── 渲染预算与降级（plan13 交叉验证后补）───────────────────────
//
// 这两条都是**审查证伪了原声明**之后补的：
//   · 原写的 `MAX_TOTAL_LINES` 判断在 push **之前**、只看"已装进去的总行数"，
//     而第一块天然满足 `0 < 4000` → **单块可以任意大**，"预算"形同虚设
//   · `computeHunks` 没有时间上限 → 48 KB 全文件重写要 **32 秒**、还同步跑在渲染进程

describe('重复内容歧义：`applyPatch` 会**向外找**精确匹配，退回必须仍落在正确的地方', () => {
  // 审查的原话：`applyPatch` 保证"整块能在文件里找到精确匹配"，**不保证在声明的偏移处**。
  // 今天不发生错位，是因为"声明位置就是差异算出来的位置，且第一次就匹配" ——
  // 而这条保证靠的是调用方的 mtime 闸，不是 applyPatch 自己。
  // 所以这一类必须留一张回归网：哪天前提被破坏，就是**静默改错地方**。
  const cases: [string, string][] = [
    ['dup\nA\nk\ndup\nA\nk\n', 'dup\nB\nk\ndup\nA\nk\n'], // 只改第一处
    ['dup\nA\nk\ndup\nA\nk\n', 'dup\nA\nk\ndup\nB\nk\n'], // 只改第二处
    ['x\ny\nx\ny\nx\n', 'x\nz\nx\ny\nx\n'],
    ['a\nb\na\nb\n', 'a\nb\na\nc\n']
  ]
  it.each(cases)('一段内容出现多次时，一块一块退完必须**精确**回到原文: %s', (before, after) => {
    let cur = after
    for (let guard = 0; guard < 12; guard++) {
      const d = computeHunks(before, cur)
      if (d.hunks.length === 0) break
      const r = revertHunk(cur, d, 1)
      expect(r.ok).toBe(true)
      if (!r.ok) break
      cur = r.text
    }
    expect(cur).toBe(before)
  })
})

describe('渲染预算：单块也不许撑爆（原声明被证伪过）', () => {
  /**
   * 造一个"**算得快、但单块很大**"的输入：往一个短文件中间插一大段。
   * ⚠️ 夹具是实测挑出来的（`n=100, ins=4200` → 60ms、单块 4206 行）：
   *    不能用"整份重写"那种输入 —— 它虽然也是单块，但要几秒才算得完，
   *    会先撞上**降级**的超时上限，于是测到的是另一条分支（我自己就踩过一次）。
   */
  const bigInsert = (n: number, ins: number): { before: string; after: string } => {
    const head = Array.from({ length: n }, (_, i) => `L${i}`)
    const mid = Math.floor(n / 2)
    const insLines = Array.from({ length: ins }, (_, i) => `N${i}`)
    return {
      before: head.join('\n'),
      after: [...head.slice(0, mid), ...insLines, ...head.slice(mid)].join('\n')
    }
  }

  it('一个**超大块**不许撑爆 MAX_TOTAL_LINES，且必须标记 truncated', () => {
    const { before, after } = bigInsert(100, 4200)
    const r = computeHunks(before, after)
    const rendered = r.hunks.reduce((s, h) => s + h.lines.length, 0)
    expect(rendered).toBeLessThanOrEqual(MAX_TOTAL_LINES)
    expect(r.truncated).toBe(true)
    expect(r.degraded).toBe(false) // 它是"算得动、但太大不显示"，不是"算不动"
    expect(r.totalHunks).toBe(1) // 确实只有一块，只是这块太大
  })

  it('**块被预算挡掉时，绝不能说"两侧完全一致"**（把"没显示"说成"没改动" = 骗人）', () => {
    const { before, after } = bigInsert(100, 4200)
    const r = computeHunks(before, after)
    expect(r.hunks).toHaveLength(0) // 一块都没装进去
    expect(r.identical).toBe(false) // ← 但它**不叫"一样"**
  })

  it('没超预算时**不许**误截断（否则界面会白说一句"没显示全"）', () => {
    const { before, after } = bigInsert(200, 3000) // 单块 3006 行 ≤ 4000
    const r = computeHunks(before, after)
    expect(r.truncated).toBe(false)
    expect(r.hunks).toHaveLength(1)
  })
})

describe('降级：改动大到算不动时必须**如实说**，不能崩也不能装成没改动', () => {
  it('编辑长度超限 → degraded（jsdiff 返回 undefined，不许直接读 .hunks 炸掉）', () => {
    const n = 12000 // 两侧完全不同：编辑距离 24000，远超上限
    const before = new Array(n).fill('aaa').join('\n')
    const after = new Array(n).fill('bbb').join('\n')
    const r = computeHunks(before, after)
    expect(r.degraded).toBe(true)
    expect(r.hunks).toEqual([])
    expect(r.identical).toBe(false) // "算不动" != "一样"
  })

  it('正常大小的改动**不许**被误判成降级', () => {
    const r = computeHunks(text('a', 'b'), text('a', 'B'))
    expect(r.degraded).toBe(false)
  })
})
