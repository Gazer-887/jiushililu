/**
 * 尺度 token 收敛（plan8 R7）—— 把 styles.css 里的裸数值换成 token。
 *
 * 收敛原则（用户 2026-09-12 圈定「①+② 结合」）：**按语义分组**（同类元素同一档），
 * 不做机械四舍五入 —— 既消灭"每处拍一个数"，又不破坏原有的疏密节奏。
 * 本脚本负责第一步（可复核的映射），并打印**逐处明细**：
 * 同类元素若因此落到了不同档，再人工统一（脚本不猜语义）。
 *
 * 用法：
 *   node scripts/tokenize-scale.cjs --dry    只报告，不写文件
 *   node scripts/tokenize-scale.cjs          执行替换
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const FILE = join(process.cwd(), 'src/renderer/src/styles.css')
const DRY = process.argv.includes('--dry')

// ── 映射表：值 → token（就近归档；等距时见下方注释的取舍）──
const FONT = {
  '10px': '--fs-xs',
  '11px': '--fs-xs',
  '11.5px': '--fs-xs',
  '12px': '--fs-sm',
  '12.5px': '--fs-sm',
  '13px': '--fs-md',
  '14px': '--fs-base',
  '15px': '--fs-base',
  '16px': '--fs-lg',
  '17px': '--fs-lg',
  '18px': '--fs-lg',
  '21px': '--fs-xl'
}

const RADIUS = {
  '2px': '--radius-sm',
  '3px': '--radius-sm',
  '4px': '--radius-sm',
  '5px': '--radius-sm',
  '6px': '--radius-md',
  '7px': '--radius-md',
  '8px': '--radius-md',
  '10px': '--radius-md',
  '12px': '--radius-lg',
  '14px': '--radius-lg'
}

/*
 * 间距映射（padding / gap / margin 共用）。
 * 「就近归档」：10px 距 8 与 12 等距 —— **取 8**（4·8 体系的主档，界面元素密集）；
 * 但内容容器类如消息气泡若因此显紧，再按语义单独上调（脚本不猜语义，故有逐处明细）。
 */
const SPACE = {
  '2px': '--sp-2',
  '3px': '--sp-2',
  '4px': '--sp-4',
  '5px': '--sp-4',
  '6px': '--sp-6',
  '7px': '--sp-6',
  '8px': '--sp-8',
  '9px': '--sp-8',
  '10px': '--sp-8',
  '11px': '--sp-12',
  '12px': '--sp-12',
  '13px': '--sp-12',
  '14px': '--sp-12',
  '15px': '--sp-16',
  '16px': '--sp-16',
  '18px': '--sp-16',
  '20px': '--sp-16',
  '22px': '--sp-24',
  '24px': '--sp-24',
  '28px': '--sp-24',
  '32px': '--sp-32',
  '36px': '--sp-32'
}

/** 找当前所在的选择器（用于逐处明细，纯文本回溯） */
function selectorAt(text, index) {
  const head = text.slice(0, index)
  const m = [...head.matchAll(/(^|\n)([^\n{}]+)\{/g)].pop()
  return m ? m[2].trim().replace(/\s+/g, ' ') : '(?)'
}

/** 单个值 → token 表达式；无法映射的原样返回 */
function one(v, table) {
  const key = v.trim()
  if (!/^[\d.]+px$/.test(key)) return { out: key, hit: false, mapped: false }
  const token = table[key]
  if (!token) return { out: key, hit: true, mapped: false }
  return { out: `var(${token})`, hit: true, mapped: true }
}

/** 多值化简：`a a` → `a`、`a b a b` → `a b`、`a b b` → `a b`
 *  （收敛顺带收益：原本"两个值其实一样"的地方也一并清掉） */
function simplify(parts) {
  if (parts.length === 4 && parts.every((v) => v === parts[0])) return [parts[0]]
  if (parts.length === 4 && parts[0] === parts[2] && parts[1] === parts[3]) {
    return [parts[0], parts[1]]
  }
  if (parts.length === 3 && parts[1] === parts[2]) return [parts[0], parts[1]]
  if (parts.length === 2 && parts[0] === parts[1]) return [parts[0]]
  return parts
}

/** 多值（如 padding: 10px 14px）逐分量映射 */
function many(v, table) {
  let mapped = false
  const parts = v.trim().split(/\s+/).map((p) => {
    const r = one(p, table)
    if (r.mapped) mapped = true
    return r.out
  })
  return { out: simplify(parts).join(' '), mapped }
}

let css = readFileSync(FILE, 'utf8')
const report = []

function sweep(label, table, propRe, multi) {
  css = css.replace(propRe, (match, pre, value, offset) => {
    const r = multi ? many(value, table) : one(value, table)
    if (!r.mapped) return match
    report.push({
      label,
      sel: selectorAt(css, offset),
      from: value.trim(),
      to: r.out
    })
    return pre + r.out + ';'
  })
}

// 注意：只匹配"属性: 值;"形态 —— :root 里的 token 定义是 `--fs-xs: 11px;`，
// 属性名不同，不会被误替换。
sweep('font-size', FONT, /(\n\s*font-size:\s*)([^;]+);/g, false)
sweep('border-radius', RADIUS, /(\n\s*border-radius:\s*)([^;]+);/g, false)
sweep('gap', SPACE, /(\n\s*(?:row-)?gap:\s*)([^;]+);/g, true)
sweep(
  'padding',
  SPACE,
  /(\n\s*padding(?:-top|-right|-bottom|-left)?:\s*)([^;]+);/g,
  true
)
sweep('margin', SPACE, /(\n\s*margin(?:-top|-right|-bottom|-left)?:\s*)([^;]+);/g, true)

// ── 报告：按「属性 | 原值 → token」聚合（要逐处时看 --detail）──
const agg = {}
for (const r of report) {
  const key = `${r.label}|${r.from}|${r.to}`
  agg[key] ??= { n: 0, sels: new Set() }
  agg[key].n++
  agg[key].sels.add(r.sel)
}

console.log('════ 收敛汇总（原值 → token × 处数 · 涉及选择器）════')
let lastLabel = ''
for (const [key, v] of Object.entries(agg)) {
  const [label, from, to] = key.split('|')
  if (label !== lastLabel) {
    console.log(`\n── ${label} ──`)
    lastLabel = label
  }
  const sels = [...v.sels]
  const shown = sels.slice(0, 3).join(' / ') + (sels.length > 3 ? ` … 共 ${sels.length} 个选择器` : '')
  console.log(`  ${from.padEnd(10)} → ${to.padEnd(16)} ×${String(v.n).padStart(3)}   ${shown}`)
}

// ── 残留检查：还有哪些裸 px 存在于这些属性上（禁止"零命中"式假通过）──
const leftovers = []
for (const m of css.matchAll(
  /\n\s*(font-size|border-radius|gap|row-gap|padding(?:-top|-right|-bottom|-left)?|margin(?:-top|-right|-bottom|-left)?):\s*([^;]+);/g
)) {
  const props = m[2].trim().split(/\s+/).filter((v) => /^[\d.]+px$/.test(v))
  if (props.length) leftovers.push(`${m[1]}: ${m[2].trim()}  ${selectorAt(css, m.index)}`)
}

console.log('\n════ 未收敛的裸值（需人工判断：line-height 类单行对齐值等）════')
console.log(leftovers.length ? leftovers.join('\n') : '（无）')
console.log(`\n总计替换 ${report.length} 处`)

if (DRY) {
  console.log('\n[dry-run] 未写文件')
} else {
  writeFileSync(FILE, css)
  console.log('\n已写入 ' + FILE)
}
