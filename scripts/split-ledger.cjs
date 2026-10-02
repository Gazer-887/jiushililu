#!/usr/bin/env node
/**
 * 一次性迁移脚本：把 `PLAN/待办总览.md` 的历史章外迁成独立附件。
 *
 * 起因（2026-10-02）：主表文件 1339 物理行里约 4/5 是历史章，而接手的人第一个读到的是
 * 主表。历史章不是垃圾（它是 09-15 / 09-19 / 09-22 / 09-29 四轮复验的**反向教材清单**），
 * 所以是**搬家不是删除**，且必须**逐字节搬**——摘要层与正文层不同源是本台账最大的病形，
 * 外迁过程本身再造一次同样病形就太讽刺了。
 *
 * 做法：只切分、只改**标题级数**（`## X` → `### X`，让附件自成一份文档、主表侧不再出现
 * 同名二级标题），正文一个字不动。级数改动数由脚本断言，改错即抛。
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'PLAN', '待办总览.md')
const OUT_MIRROR = join(ROOT, 'PLAN', '附件-待办总览-历史台账.md')

// 切分点：主表文件的第二章结束之后、「## 三、历史失真与异常」开始处
const CUT = '## 三、历史失真与异常'

// 外迁段的**全部二级标题**（切分点之后到文件末尾，## 与 ### 都要降一级）。
// 这份清单与下文断言一一对应：漏一个 / 多一个都抛，不靠肉眼核。
const EXPECTED_H2 = [
  '## 三、历史失真与异常',
  '## 〇、对账与读法',
  '## 一、失真分类台账',
  '## 二、编号异常登记',
  '## 三、无声消失的条目',
  '## 四、缺「问过没有」日期的待拍板项',
  '## 五、归不进任何一类的那一条',
  '## 附录 · 本次只读复核',
  '## 四、D 编号遗留',
  '## 五、对外文档与源码不一致',
  '## 六、对交叉验证与归并的说明',
]

const src = readFileSync(SRC, 'utf8')
const rawLines = src.split('\n')

const cutIdx = rawLines.findIndex((l) => l.startsWith(CUT))
if (cutIdx < 0) {
  console.error(`✗ 找不到切分点「${CUT}」`)
  process.exit(1)
}

// 主表侧：1..cutIdx（不含切分点那一行）。**不整理尾部空行** ——
// `kept` 与 `moved` 的拼接必须能逐行还原原文，任何"顺手美化"都会破坏守恒断言
//（首跑即踩：`.replace(/\n+$/, '') + '\n'` 把原文的收尾空行吃掉了）。
const keptLines = rawLines.slice(0, cutIdx)
const kept = keptLines.join('\n')
// 附件侧：切分点起直到文件末尾
const moved0 = rawLines.slice(cutIdx)

// 切分点之前**只允许**有「一、主表」与「二、待拍板项」两章 ——
// 多一章说明切点选早了（把历史章留在了主表侧），少一章说明切点选晚了。
const ALLOWED_H2 = ['## 一、主表', '## 二、待拍板项']
const keptH2 = kept.split('\n').filter((l) => /^## /.test(l))
// ⚠️ 同上游清单，**前缀匹配**：标题带括号注（`## 一、主表（按状态排：…）`）
const strayBefore = keptH2.filter((l) => !ALLOWED_H2.some((a) => l.startsWith(a)))
if (strayBefore.length || keptH2.length !== ALLOWED_H2.length) {
  console.error('✗ 主表侧章节与预期不符（切歪了）')
  console.error('  实际：\n    ' + keptH2.join('\n    '))
  console.error('  预期：\n    ' + ALLOWED_H2.join('\n    '))
  process.exit(1)
}

// 降级：切分点之后**所有** `## ` 与 `### ` 标题统一降一级。
// 例外：形如 `## 2.1` / `### 3-1` 这种**数字编号小节**也要降（它们同属该章的层级体系）。
let h2Demoted = 0
let h3Demoted = 0
const moved = moved0.map((l) => {
  if (/^## /.test(l)) {
    h2Demoted++
    return '#' + l
  }
  if (/^### /.test(l)) {
    h3Demoted++
    return '#' + l
  }
  return l
})

// 断言：降级数必须与预期清单一致（各自允许多个三级标题，故只钉二级逐一命中）
// ⚠️ 按**前缀**匹配，不做全等 —— 标题上大多带括号补充语
//（`## 三、历史失真与异常（**重建这张表时最该避免重猜**）`），
// 全等断言会把"我清单里漏抄了括号注释"误报成"外迁搬丢了章"（首跑即踩）。
const gotH2 = moved.filter((l) => /^### [^\s#]/.test(l)).map((l) => l.slice(1))
const missing = EXPECTED_H2.filter((h) => !gotH2.some((g) => g.startsWith(h)))
const extra = gotH2.filter((h) => !EXPECTED_H2.some((e) => h.startsWith(e)))
if (missing.length || extra.length) {
  console.error('✗ 二级标题清单与预期不符')
  if (missing.length) console.error('  预期有但没搬到：\n    ' + missing.join('\n    '))
  if (extra.length) console.error('  搬到但不在预期内：\n    ' + extra.join('\n    '))
  process.exit(1)
}

// 字节守恒断言：正文内容不许在搬的过程中被改写。
// 做法是把两侧拼接后与原文**逐行比对**（唯一允许的差异就是标题被插入的 `#`）。
const reassembled = [...keptLines, ...moved]
// 归一化：把**任意数量**的前导 `#` + 空格去掉再比对 ——
// 外迁唯一被允许的改动就是标题级数，其余一个字符都不许动。
//（首版只剥 `## `，降级后的 `### ` 会剩下一个 `#` 被当成"内容被改写"，是断言自身的漏洞。）
const stripped = (s) => s.replace(/^#+\s/, '')
const original = rawLines.map(stripped)
const rebuilt = reassembled.map(stripped)
if (original.length !== rebuilt.length) {
  console.error(`✗ 行数不守恒：原文 ${original.length} / 重装 ${rebuilt.length}`)
  process.exit(1)
}
for (let i = 0; i < original.length; i++) {
  if (original[i] !== rebuilt[i]) {
    console.error(`✗ 第 ${i + 1} 行内容被改写：\n  原文: ${original[i]}\n  重装: ${rebuilt[i]}`)
    process.exit(1)
  }
}

const banner = `# 附件 · 待办总览 · 历史台账

> **性质**：这是 \`PLAN/待办总览.md\` 的**历史章附件**，2026-10-02 从主表文件外迁而来（[WorkBuddy·Anan]）。
> **为什么外迁**：主表文件原有 1339 物理行，其中约 4/5 是历史章 —— 接手的人第一个读到的却是主表，
> 而"第一个读到的位置最不靠谱"正是这份台账反复复发的 P1 病形。⇐ 这个理由本身取自本附件的 §一 1.1 规律 3。
> **为什么不是删除**：本附件是**反面教材清单**，不是欠账台账。它记录的是 09-15 / 09-19 / 09-22 / 09-29
> 四轮复验查出的失真形态；新表若重现其中任一病形，等于那四轮复验白做。
> **唯一源声明**：**未完成项的唯一源仍是 \`PLAN/待办总览.md\` 的主表**。本附件不含任何待办项，
> 读它不能替代读主表。
> ⚠️ **正文一个字未改**，只把标题降了一级（\`## X\` → \`### X\`）让它自成一份文档。
> 外迁的字节守恒由 \`scripts/split-ledger.cjs\` 断言过（逐行比对，只允许标题插入的 \`#\` 差异）。

---

`

writeFileSync(OUT_MIRROR, banner + moved.join('\n').replace(/\n+$/, '') + '\n', 'utf8')
writeFileSync(SRC, kept + '\n', 'utf8')

console.log(`✓ 主表侧 ${keptLines.length} 行（原 ${rawLines.length} 行）`)
console.log(`✓ 附件侧 ${moved.length} 行，降级：## × ${h2Demoted} / ### × ${h3Demoted}`)
console.log(`✓ 二级标题清单 ${gotH2.length} 项逐一命中预期`)
console.log('✓ 字节守恒断言通过（逐行比对，仅标题级数差异）')
