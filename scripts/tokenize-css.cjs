/**
 * 一次性工具：把 styles.css 的裸色值收敛为 CSS 变量（plan7 设置·外观自定义的前置）。
 * 跑完即可删。替换规则见 TOKEN_MAP；:root 块内的定义行不受影响。
 */
const fs = require('fs')
const { join } = require('node:path')

const CSS = join(process.cwd(), 'src/renderer/src/styles.css')
let css = fs.readFileSync(CSS, 'utf8')
const lines = css.split('\n')

// ── 1. 定位 :root 块的行区间（定义行不做替换）──
let rootStart = -1
let rootEnd = -1
lines.forEach((l, i) => {
  if (l.trim() === ':root {') rootStart = i
  if (rootStart >= 0 && rootEnd === -1 && l.trim() === '}') rootEnd = i
})
if (rootStart === -1) throw new Error('找不到 :root 块')
console.log(`:root 区间: 行 ${rootStart + 1} – ${rootEnd + 1}`)

// ── 2. 在 :root 末尾（--radius 之前）补齐缺失变量 ──
const NEW_VARS = [
  '  /* 交互 hover 深值 / accent 上的前景（按钮白字等） */',
  '  --accent-hover: #14508c;',
  '  --on-accent: #ffffff;',
  '  /* 警告（琥珀系）—— 之前散落 8 处裸值，未进 token */',
  '  --warn: #ba7517;',
  '  --warn-soft: #faeeda;',
  '  --warn-border: #fac775;',
  '  --warn-deep: #854f0b;'
].join('\n')

if (!css.includes('--accent-hover')) {
  const idx = lines.findIndex((l) => l.includes('--radius:'))
  if (idx === -1) throw new Error('找不到 --radius 行')
  lines.splice(idx, 0, NEW_VARS)
  console.log('已插入新变量定义')
}

// ── 3. 逐行替换裸值（跳过 :root 定义区）──
const MAP = [
  // 先处理带 fallback 的特殊写法（var(--warn-fg, #ba7517) 用了不存在的变量名）
  ['var(--warn-fg, #ba7517)', 'var(--warn)'],
  ['#ba7517', 'var(--warn)'],
  ['#854f0b', 'var(--warn-deep)'],
  ['#faeeda', 'var(--warn-soft)'],
  ['#fac775', 'var(--warn-border)'],
  ['#14508c', 'var(--accent-hover)'],
  ['#d9e9fa', 'var(--accent-soft)'],
  ['color: #fff;', 'color: var(--on-accent);'],
  ['background: #fff;', 'background: var(--on-accent);']
]

let replaced = 0
for (let i = 0; i < lines.length; i++) {
  if (i >= rootStart && i <= rootEnd) continue // :root 定义区不替换
  for (const [from, to] of MAP) {
    if (lines[i].includes(from)) {
      lines[i] = lines[i].split(from).join(to)
      replaced++
    }
  }
}
console.log(`替换了 ${replaced} 行`)

// ── 4. 在 :root 块之后追加水墨主题 ──
const INK_THEME = [
  '',
  '/*',
  ' * 水墨主题（2026-09-12 用户定稿：黑白灰 + 红，参考 opencode 的克制感）。',
  ' * 用色逻辑：灰阶承担全部层次（墨分五色），红只做点睛（朱砂逻辑，面积必须极小）；',
  ' * 语义色服从色彩体系 —— 正向/激活用墨色（不用绿/蓝），负向用朱砂。',
  ' * 详见 DIARY/专题-水墨风配色.md。切换方式：html[data-theme="ink"]。',
  ' */',
  'html[data-theme="ink"] {',
  '  --bg: #f6f5f2;',
  '  --panel: #ffffff;',
  '  --border: #ebe9e3;',
  '  --text: #1c1c1a;',
  '  --muted: #8b8a83;',
  '  --accent: #1c1c1a;',
  '  --accent-hover: #000000;',
  '  --on-accent: #ffffff;',
  '  --accent-soft: #efeee9;',
  '  --accent-border: #ddd9d0;',
  '  --ok: #1c1c1a;',
  '  --ok-soft: #efeee9;',
  '  --ok-border: #ddd9d0;',
  '  --danger: #a8342c;',
  '  --danger-soft: #f7ece9;',
  '  --danger-border: #e8cfc8;',
  '  --warn: #a8342c;',
  '  --warn-soft: #f7ece9;',
  '  --warn-border: #e8cfc8;',
  '  --warn-deep: #a8342c;',
  '}'
].join('\n')

// 找 :root 块结束行（在插入新变量后行号可能已变，重找）
const reRootStart = lines.findIndex((l) => l.trim() === ':root {')
let reRootEnd = -1
for (let i = reRootStart; i < lines.length; i++) {
  if (lines[i].trim() === '}') {
    reRootEnd = i
    break
  }
}
if (!css.includes('data-theme="ink"')) {
  lines.splice(reRootEnd + 1, 0, INK_THEME)
  console.log('已插入水墨主题定义')
}

fs.writeFileSync(CSS, lines.join('\n'), 'utf8')
console.log('完成')
