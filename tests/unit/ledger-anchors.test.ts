import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * 「待办总览」台账守卫。
 *
 * 这张表的价值全在"不失真"，而失真不会自己报错 —— 09-15 与 09-22 两次全量复验
 * 查出 20+ 与 13 处，09-29 重建时独立复核又查出 5 类约 40 处。所以用机器把
 * 结构判据钉死：能被机械判的（行数、锚点、状态枚举、排序、互引）一律交给这里。
 *
 * ⚠️ `PLAN/` 按 D-094 纯本地、不入 git ⇒ **CI 上这个文件不存在**，此时整组跳过
 *    （与本仓已有 1 个 skip 同惯例）。别把它当成"CI 也在守"，CI 守的是 docs/ 那层。
 */
const LEDGER = join(process.cwd(), 'PLAN', '待办总览.md')

const VALUES = ['⏳ 未开始', '🚧 进行中', '❌ 不做', '✅ 已完成', '❓ 待确认'] as const
const RANK = new Map(VALUES.map((v, i) => [v, i]))

type Row = { seq: number; anchor: string; group: string; state: string; rest: string[] }

// ⚠️ 必须在**模块顶层**同步读完，不能放进 beforeAll ——
// `it.skipIf(cond)` 的条件在**收集阶段**求值，那时 beforeAll 还没跑，
// 于是条件恒假、整组被跳过（看起来"全绿"实际一条没跑，2026-09-30 现场踩过）。
const exists = existsSync(LEDGER)
const raw = exists ? readFileSync(LEDGER, 'utf8') : ''
const lines = raw.split('\n')
const s0 = lines.findIndex((l) => l.startsWith('## 一、主表'))
const e0 = s0 < 0 ? -1 : lines.findIndex((l, i) => i > s0 && l.startsWith('## '))
const head = s0 < 0 ? '' : lines.slice(0, s0).join('\n')
const mainBody = s0 < 0 ? [] : lines.slice(s0, e0 < 0 ? lines.length : e0)

const rows: Row[] = []
for (const ln of mainBody) {
  const t = ln.trim()
  if (!t.startsWith('|') || [...t].every((c) => '|-: '.includes(c))) continue
  const c = t.replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
  if (c.length < 4 || !/^\d+$/.test(c[0])) continue
  rows.push({ seq: Number(c[0]), anchor: c[1], group: c[2], state: c[3], rest: c.slice(4) })
}

const live = exists && rows.length > 0

function walk(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else out.add(basename(p))
  }
}

describe('待办总览 · 结构守卫', () => {
  it.skipIf(!exists)('文件存在（CI 上 PLAN/ 不入 git ⇒ 跳过）', () => {
    expect(existsSync(LEDGER)).toBe(true)
  })

  it.skipIf(!live)('每行都有锚点，且锚点不是裸行号', () => {
    const bad = rows.filter((r) => !r.anchor || [...r.anchor].every((c) => '- '.includes(c)))
    expect(bad.map((r) => r.seq)).toEqual([])
    // 裸行号引用会漂（AGENTS.md §九）—— 锚点必须含文件名
    const bare = rows.filter(
      (r) => /:\d+$/.test(r.anchor) && !/\.(md|ts|tsx|cjs|json)\b/.test(r.anchor)
    )
    expect(bare.map((r) => r.seq)).toEqual([])
  })

  it.skipIf(!live)('状态只用四值 + ❓（母本 §3.2.3）', () => {
    const bad = rows.filter((r) => !VALUES.includes(r.state as never))
    expect(bad.map((r) => `${r.seq}:${r.state}`)).toEqual([])
  })

  it.skipIf(!live)('序号连续、无重号（防"以为别的文档会顺带更新"式的缺行）', () => {
    const seqs = rows.map((r) => r.seq)
    const gaps: string[] = []
    let prev = 0
    for (const s of seqs) {
      if (s !== prev + 1) gaps.push(`${prev}->${s}`)
      prev = s
    }
    expect(gaps).toEqual([])
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it.skipIf(!live)('按状态排序：⏳ → 🚧 → ❌ → ✅ → ❓', () => {
    const ranks = rows.map((r) => RANK.get(r.state) as number)
    const bad: string[] = []
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] < ranks[i - 1]) bad.push(`${rows[i - 1].seq}(${rows[i - 1].state}) -> ${rows[i].seq}`)
    }
    expect(bad).toEqual([])
  })

  it.skipIf(!live)('已完成的行不许用「划掉」表达（改成 ✅ 或 ❌，两值不可混）', () => {
    // 旧表把「已做」写成 `~~…~~` 一行，与「不做」同形 ⇒ 读者分不出终态
    const bad = rows.filter((r) => r.anchor.includes('~~'))
    expect(bad.map((r) => r.seq)).toEqual([])
  })

  it.skipIf(!live)('⚠️ 头注声明的行数 = 实际行数（摘要层与正文层同源）', () => {
    // 这条是 09-15 查出 20+ 处失真里最便宜的一类：头注是下一端第一个读到的位置
    const m = head.match(/主表\s*(\d+)\s*行/)
    expect(m, '头注必须声明「主表 N 行」').not.toBeNull()
    expect(Number(m![1])).toBe(rows.length)
  })

  it.skipIf(!live)('锚点里的文件名要么真实存在，要么显式标注〔路径待核〕', () => {
    // 09-30 独立复核抓到 22 行锚点指向不存在的目录（src/main/tools 等）。
    // 修法不是删行（那会抹掉「plan 原文就写着失效路径」这个失真本身），
    // 而是强制显式标注 —— 没标注的失效锚点会让主键悄悄失效。
    //
    // ⚠️ 三个坑都是实测踩出来的：
    //   ① 只查「含 / 的目录形态」会漏掉 `x.ts:12` 这种**带假扩展名**的锚点（变异能混过）；
    //   ② 锚点写**裸文件名**（`PlusMenu.tsx`，AGENTS.md §九 允许的简写）时，
    //      按「根目录 + 几个 base」找会误报 —— 文件其实在 `src/renderer/src/components/`。
    //      ⇒ 必须按 **basename 全仓匹配**。
    //   ③ 2026-10-01 补：`.github/` 不在遍历表里 ⇒ `ci.yml` 这类**真存在**的锚点被判失效；
    //      修 28 行失效锚点时暴露（那行原本靠 〔路径待核〕 整行跳过，标记一摘就红）。
    //   ④ 2026-10-01 补：仓外路径（本机工具，如 `D:/Tools/...`）永远过不了存在性检查，
    //      ⇒ 新增 `〔仓外〕` 显式标记，语义与 〔路径待核〕 同：**显式声明不可核，而不是漏核**。
    const knownBasenames = new Set<string>()
    for (const dir of ['src', 'tests', 'scripts', 'lat.md', 'PLAN', 'NOTEBOOK', 'docs', 'config', 'resources', '.github']) {
      walk(join(process.cwd(), dir), knownBasenames)
    }
    const DIR_PREFIX = ['plan', 'NOTEBOOK', 'docs', 'lat.md', 'src', 'tests', 'scripts', 'resources', 'config']
    const unmarked: string[] = []
    for (const r of rows) {
      if (r.anchor.includes('〔路径待核〕') || r.anchor.includes('〔仓外')) continue
      // token 要含中文（锚点里大量中文文件名），且必须以字母/数字/汉字开头
      const tokens = r.anchor.match(/[A-Za-z0-9一-龥][A-Za-z0-9_.\-一-龥]*/g) ?? []
      for (const tk of tokens) {
        // 扩展名必须以字母开头 —— 否则 `3.3`（节号）、`0.75`（阈值）会被当文件名
        const looksFile = /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(tk)
        const knownDir = DIR_PREFIX.some((p) => tk === p || tk.startsWith(p + '/') || tk.startsWith(p))
        if (!looksFile && !knownDir) continue
        if (existsSync(join(process.cwd(), tk)) || knownBasenames.has(tk)) continue
        // 允许省略扩展名的 plan 引用：`plan8` 与 `plan8_健壮性与技术债`（真实文件名带 .md）
        if (/^plan\d+$/.test(tk) || /^plan\d+_.+$/.test(tk) || /^[A-Za-z0-9\-_一-龥]+\.md$/.test(tk)) continue
        unmarked.push(`${r.seq}:${tk}`)
      }
    }
    expect(unmarked).toEqual([])
  })

  it.skipIf(!live)('必备章节齐全（缺一节就说明重建时漏了那一块）', () => {
    for (const h of ['## 一、主表', '## 二、待拍板项', '## 三、历史失真与异常', '## 五、对外文档与源码不一致']) {
      expect(raw).toContain(h)
    }
  })

  // 2026-10-01 台账重建后加：`plan59_待办总览重建` 与 `plan59_主线收束` 撞号那次，
  // 现有 `:140` 那三条放行**不做存在性判断**，改号改错不会报红（撞号就是活样本）。
  // 这条只管**具名 plan 文件引用**：形如 `planN_xxx.md` 的 token 必须能在 PLAN/ 下解析。
  // ⚠️ 故意不含 `planN` / `planN_xxx` 裸形（那是 AGENTS §九 允许的简写，且历史表里大量存在）。
  it.skipIf(!live)('具名 plan 文件引用必须存在（治撞号与改号错）', () => {
    const planFiles = new Set<string>()
    walk(join(process.cwd(), 'PLAN'), planFiles)
    const bad: string[] = []
    for (const r of rows) {
      const tokens = r.anchor.match(/plan\d+_[^\s:：,，、。）〕】`]+\.md/g) ?? []
      for (const tk of tokens) if (!planFiles.has(tk)) bad.push(`${r.seq}:${tk}`)
    }
    expect(bad).toEqual([])
  })

  // 2026-10-01 新增（**守卫新闸之一**：〔路径待核〕的保质期）。
  // 为什么需要它：〔路径待核〕是一张"允许失效"的通行证，没有期限就会永远漂着 ——
  // 与 AGENTS §四 规律 1「等人拍板的条目会永远漂着」是同一个病。
  // 判据两条：① 每条 〔路径待核〕 必须带 〔限期 YYYY-MM-DD〕；② 限期不许已过。
  // 格式写成**两个独立括号**（〔路径待核〕〔限期 …〕）而不是塞进一个括号里 ——
  // 上面那条存在性判据用的是 `includes('〔路径待核〕')` 精确子串，改格式会让整行重新变红（实测踩过）。
  it.skipIf(!live)('〔路径待核〕必须带未过期的〔限期〕（防待核锚点无限期漂着）', () => {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const bad: string[] = []
    for (const r of rows) {
      if (!r.anchor.includes('〔路径待核〕')) continue
      const m = r.anchor.match(/〔限期\s*(\d{4}-\d{2}-\d{2})〕/)
      if (!m) bad.push(`${r.seq}:缺〔限期〕`)
      else if (m[1] < today) bad.push(`${r.seq}:限期 ${m[1]} 已过（今天 ${today}）`)
    }
    expect(bad).toEqual([])
  })
})

