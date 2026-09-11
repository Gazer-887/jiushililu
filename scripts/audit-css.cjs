/**
 * CSS 债务审计（plan8 R7 设计系统抽取用）
 *
 * 用途：列出 styles.css 里各项"裸数值"的取值分布与使用场景，
 * 为「定 token 阶梯」提供事实依据 —— 不靠感觉拍板。
 *
 * 用法：node scripts/audit-css.cjs
 *
 * 输出：每个取值 → 出现次数 + 代表性选择器（便于判断该值属于哪一档）
 */

const fs = require('fs')
const { join } = require('node:path')

const CSS = join(process.cwd(), 'src/renderer/src/styles.css')
const lines = fs.readFileSync(CSS, 'utf8').split('\n')

/** 逐个属性收集：值 → 用到的选择器（每个值最多留 SAMPLE 个） */
const SAMPLE = 4
function collect(re) {
  const map = new Map()
  const counts = new Map()
  let sel = '(root)'
  for (const line of lines) {
    // 选择器行（以 . 或 # 开头且含 {）；@media 等不在此列，忽略即可
    const m = line.match(/^([.#][\w-]*[^{]*)\{/)
    if (m) {
      sel = m[1].trim()
      continue
    }
    const g = line.match(re)
    if (!g) continue
    const v = g[1].trim()
    counts.set(v, (counts.get(v) ?? 0) + 1)
    if (!map.has(v)) map.set(v, [])
    const arr = map.get(v)
    if (arr.length < SAMPLE && !arr.includes(sel)) arr.push(sel)
  }
  return { map, counts }
}

function report(title, re) {
  console.log('\n════ ' + title + ' ════')
  const { map, counts } = collect(re)
  const rows = [...map.entries()].sort((a, b) => {
    const na = Number.parseFloat(a[0].replace(/[^0-9.]/g, '')) || 0
    const nb = Number.parseFloat(b[0].replace(/[^0-9.]/g, '')) || 0
    return na - nb
  })
  let total = 0
  for (const [v, sels] of rows) {
    const n = counts.get(v)
    total += n
    console.log(`  ${v.padEnd(9)} ×${String(n).padStart(3)}  ${sels.join(' | ')}`)
  }
  console.log(`  ── 共 ${rows.length} 种取值 / ${total} 处使用`)
}

report('字号 font-size', /font-size:\s*([^;]+);/)
report('圆角 border-radius', /border-radius:\s*([^;]+);/)
report('间距 padding', /(?<![\w-])padding:\s*([^;]+);/)
report('间距 gap', /(?<![\w-])gap:\s*([^;]+);/)
report('行高 line-height', /line-height:\s*([^;]+);/)
