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

  // ⚠️ 2026-10-02 收紧：本章原钉四条（`## 一/二/三/五`），其中 `## 三、历史失真与异常` 与
  // `## 五、对外文档与源码不一致` 已**外迁**到 `PLAN/附件-待办总览-历史台账.md`（逐字节搬，只降标题级数）。
  // ⇒ 本节只钉**主表现存的两章**；外迁件是否还在，由下一条单独钉（拆成两条的理由：
  //   章**在不在主表里** 与 附件**有没有被搬丢** 是两件事，混一条会说不清红的是哪个）。
  it.skipIf(!live)('必备章节齐全（缺一节就说明重建时漏了那一块）', () => {
    for (const h of ['## 一、主表', '## 二、待拍板项']) {
      expect(raw).toContain(h)
    }
    // 反向：已外迁的两章**不许**再出现在主表里 —— 否则就是外迁没做完 / 又抄回来一份，
    // 而"同一事实登记在两处 ⇒ 必有 N−1 处没人擦"正是本附件 §一 P2 病形。
    for (const h of ['## 三、历史失真与异常', '## 五、对外文档与源码不一致']) {
      expect(raw).not.toContain(h)
    }
  })

  // 2026-10-02 新增：**头注里引用的 `PLAN/` 文件必须真实存在**。
  // 为什么单列：主表每行锚点早有存在性判据（见上），但**头注与保护栏那块的路径引用没人管** ——
  // 外迁当天顺手核出 6 处假路径：`PLAN/.复核-V2.md` 等 4 份文件实际都在
  // `PLAN/.重建证据-2026-09-29/` 下，而头注写作 `PLAN/.复核-V2.md`（P8「跨文件引用失效」病形）。
  // 它比主表锚点更危险：头注是**下一端第一个读到的位置**，读到假路径会以为"证据没了"。
  // ⚠️ 只查形如 `PLAN/xxx` 的显式路径；裸文件名（`plan59`）不归本条管（AGENTS §九 允许简写）。
  it.skipIf(!live)('头注引用的 PLAN/ 路径必须存在（治「证据文件写了假路径」）', () => {
    const bad: string[] = []
    const seen = new Set<string>()
    for (const m of head.matchAll(/PLAN\/[A-Za-z0-9._\-\u4e00-\u9fa5]+(?:\/[A-Za-z0-9._\-\u4e00-\u9fa5]+)*/g)) {
      const p = m[0].replace(/[.,、。）]+$/, '')
      if (seen.has(p)) continue
      seen.add(p)
      // ⚠️ 排掉**通配/族指**写法：`PLAN/plan*`（头注"汇总自 PLAN/plan* 全部文件"）、
      // 以及 `PLAN/plan` 这种被 `*` 截断后的残形 —— 它们不是具体路径，不存在性不适用。
      //（首跑即踩：判据把 `PLAN/plan*` 读成 `PLAN/plan` 报红，属判据自身误伤而非台账有错。）
      const after = head.slice(m.index + m[0].length, m.index + m[0].length + 1)
      if (/[*？]/.test(after) || p === 'PLAN/plan') continue
      if (!existsSync(join(process.cwd(), p))) bad.push(p)
    }
    expect(bad).toEqual([])
  })

  // 2026-10-02 新增：外迁件必须存在（主表里那两章的正文全在它那儿，丢了就是静默消失）。
  // ⚠️ 这条的**红**只在"外迁件被删或改名"时出现；主表侧的两条 not.toContain 才是"又抄回来"的红。
  it.skipIf(!live)('外迁的历史章附件必须存在（防外迁丢件）', () => {
    const annex = join(process.cwd(), 'PLAN', '附件-待办总览-历史台账.md')
    expect(existsSync(annex)).toBe(true)
    // 附件里必须真有那两章的正文（只查存在会漏掉"建了个空壳"）
    const annexRaw = readFileSync(annex, 'utf8')
    for (const h of ['### 三、历史失真与异常', '### 五、对外文档与源码不一致']) {
      expect(annexRaw).toContain(h)
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

  // 2026-10-01 新增（**守卫新闸之三**：双标自洽）。
  // 主表内互引一律写成 `#N · SID S0NN`（双标）。为什么要双标：`第 N 行` 那种单标在
  // 「序号读法」与「物理行号读法」下会落到不同的行（09-30 实测**两读同点 = 0 处**），
  // 单一读法根本解不出引用。而 SID 是**冻结号**（插行重排都不变），序号会漂。
  // ⇒ 双标的两半必须互相印证：`#N` 那一行的 SID，必须正好是 `S0NN`。
  // ⚠️ 只查双标；裸 `#N` 与裸 `第 N 行` 不归本条管。
  it.skipIf(!live)('互引双标自洽：`#N · SID S0NN` 的两半必须指向同一行', () => {
    const seq2sid = new Map(rows.map((r) => [r.seq, r.rest[r.rest.length - 1]]))
    const bad: string[] = []
    for (const r of rows) {
      const txt = [r.anchor, ...r.rest].join(' ')
      for (const m of txt.matchAll(/#(\d+) · SID (S\d+)/g)) {
        const n = Number(m[1])
        const real = seq2sid.get(n)
        if (real !== m[2]) bad.push(`#${r.seq} 引 #${n}·${m[2]}，但 #${n} 实为 ${real ?? '不存在'}`)
      }
    }
    expect(bad).toEqual([])
  })

  // 2026-10-01 新增（**守卫新闸之四**：✅ 的成色披露）。
  // ⚠️ 这条**刻意不判「未复验的 ✅ 有多少」** —— 判红会诱导下一端把 ⚠️ 直接改成 ✅ 去消红，
  // 那是在逼人伪造复核，比不披露更坏。只钉「头注披露的数 = 实数」（同源原则）：
  // 想让它变少，去做真复核，不是去改头注那一行。
  it.skipIf(!live)('头注披露的 ✅/⚠️ 成色数 = 实数（同源原则）', () => {
    const m = head.match(/✅\s*(\d+)\s*条，其中\s*⚠️\s*未独立复验\s*(\d+)\s*条/)
    expect(m, '头注必须披露「✅ N 条，其中 ⚠️ 未独立复验 M 条」').not.toBeNull()
    const done = rows.filter((r) => r.state.startsWith('✅')).length
    const unverified = rows.filter((r) => r.state.startsWith('✅') && r.rest[2] === '⚠️').length
    expect([Number(m![1]), Number(m![2])]).toEqual([done, unverified])
  })
})

