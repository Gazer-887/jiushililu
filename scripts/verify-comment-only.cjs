/**
 * 校验"这次改动**只动了注释与空白**"（plan8 R14 注释整理批次的验收工具）。
 *
 * 做法：用 TypeScript 的 scanner 把新旧两份文件都**跳过 trivia**（注释/空白）扫成 token 序列，
 * 逐项比对 —— 序列完全一致 ⇒ 代码语义没变；只要有一个 token 不同（包括字符串字面量里的 UI 文案），
 * 就报出来并给出**行号**。
 *
 * 为什么不看 `git diff` 的增删行：注释与代码常在同一行（`const a = 1 // 说明`），
 * 按行判断必然误报/漏报。token 级才是"语义"这一层。
 *
 * 用法：
 *   node scripts/verify-comment-only.cjs            # 与 HEAD 比（工作区改动）
 *   node scripts/verify-comment-only.cjs <ref>      # 与指定提交比
 */
const { execSync } = require('node:child_process')
const { readFileSync, existsSync } = require('node:fs')
const ts = require('typescript')

const base = process.argv[2] ?? 'HEAD'

/**
 * ⚠️ 比对前先**归一化行尾**：本仓库 `.gitattributes` 是 `* text eol=lf` + `core.autocrlf=true`
 * —— 提交进库的是 LF，而**工作区检出的是 CRLF**。不归一化的话，JSX 文本节点（`JsxText`）
 * 会把 `\n` 与 `\r\n` 当成两个不同的 token，报出"改了代码"的假阳性。
 */
const norm = (t) => t.replace(/\r\n/g, '\n')

function kindOf(file) {
  if (file.endsWith('.tsx')) return { sk: ts.ScriptKind.TSX, variant: ts.LanguageVariant.JSX }
  if (file.endsWith('.ts')) return { sk: ts.ScriptKind.TS, variant: ts.LanguageVariant.Standard }
  if (/\.(cjs|js|mjs)$/.test(file)) return { sk: ts.ScriptKind.JS, variant: ts.LanguageVariant.Standard }
  return null
}

/**
 * 扫成 token 序列（跳过注释与空白），每项带**所在行**便于定位。
 *
 * ⚠️ 用**解析器的叶子节点**取 token，不要手写 scanner 驱动：
 * 手写 `ts.createScanner` 必须先正确处理模板字符串的重新扫描（`reScanTemplateToken`），
 * 漏了就会把一大段代码连同注释吞成一个"模板 token"，于是**把纯注释改动误报成语义改动**
 * （本工具第一版就这么错过：132 个文件里报了 67 个假阳性）。
 */
function tokens(text, variant, sk) {
  const sf = ts.createSourceFile('x', text, ts.ScriptTarget.Latest, /* setParentNodes */ false, sk)
  const out = []
  const visit = (node) => {
    // ⚠️ 解析器会把 **JSDoc 注释**当成声明节点的子节点返回（kind = JSDocComment）——
    // 不跳过的话，"改了注释"会被判成"改了 token"（本工具第二版就报了一屏假阳性）。
    if (node.kind === ts.SyntaxKind.JSDocComment) return
    // ⚠️ JSX 里的注释写成 `{/* … */}`，AST 把它表示成**空的 JSX 表达式容器**（`{` `}` 两个 token）。
    // 不跳过的话，"删掉一条 JSX 注释"会被判成"改了代码"（本工具第三版就卡在这条上）。
    if (ts.isJsxExpression(node) && node.expression === undefined) return
    const kids = node.getChildren(sf)
    if (kids.length === 0) {
      // ⚠️ `JsxText` 的 token 文本**含缩进与换行** —— 那是排版不是语义，折叠空白再比
      // （否则"删掉 JSX 里的一行注释"会让后面的文本节点整体位移，报出一长串假阳性）。
      const raw = node.getText(sf)
      const isJsxText = node.kind === ts.SyntaxKind.JsxText
      const text = isJsxText ? raw.replace(/\s+/g, ' ').trim() : raw
      // 纯空白的 JSX 文本节点**直接丢掉**：删掉一条 JSX 注释会把原来被切开的两段空白
      // 合并成一段（2 个节点 → 1 个），节点个数变了但语义没变。
      if (isJsxText && text === '') return
      out.push({
        t: ts.SyntaxKind[node.kind] + '|' + text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      })
      return
    }
    for (const k of kids) visit(k)
  }
  visit(sf)
  return out
}

/** 第一个差异：返回两边的 token 与行号 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i].t !== b[i].t) return { i, a: a[i], b: b[i] }
  if (a.length !== b.length) {
    return { i: n, a: a[n] ?? { t: '(缺)', line: 0 }, b: b[n] ?? { t: '(多)', line: 0 } }
  }
  return null
}

const nameStatus = execSync(`git diff --name-status ${base}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const rows = nameStatus
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.split(/\s+/))

let checked = 0
let bad = 0
let skipped = 0
const failures = []

for (const [status, file] of rows) {
  const kind = kindOf(file)
  if (!kind || status === 'D') {
    skipped++
    continue
  }
  let oldText
  try {
    oldText = execSync(`git show ${base}:${file}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    skipped++ // 新增文件：没有旧版本，不在本工具职责内（人工看）
    continue
  }
  if (!existsSync(file)) {
    skipped++
    continue
  }
  const newText = readFileSync(file, 'utf8')
  const a = tokens(norm(oldText), kind.variant, kind.sk)
  const b = tokens(norm(newText), kind.variant, kind.sk)
  checked++
  const d = firstDiff(a, b)
  if (d) {
    bad++
    failures.push({ file, d })
    console.log(`❌ ${file}`)
    console.log(`     旧（第 ${d.a.line} 行）: ${JSON.stringify(d.a.t).slice(0, 160)}`)
    console.log(`     新（第 ${d.b.line} 行）: ${JSON.stringify(d.b.t).slice(0, 160)}`)
    // 差异上下文：只看那一个 token 常常判断不出"到底改了什么"，把前后各 4 个也打出来
    const ctx = (arr, i) => arr.slice(Math.max(0, i - 4), i + 5).map((x) => `${x.line}:${x.t}`).join(' | ')
    console.log(`     旧上下文: ${ctx(a, d.i).slice(0, 300)}`)
    console.log(`     新上下文: ${ctx(b, d.i).slice(0, 300)}`)
  }
}

console.log(`\n检查 ${checked} 个文件（跳过 ${skipped}：新增/删除/非源码）`)
if (bad) {
  console.log(`==== 不通过：${bad} 个文件的 token 序列不一致 ====`)
  console.log('（注意：字符串字面量里的改动也会被判为不一致 —— 例如"注释写在注入 JS 的模板串里"那种）')
  process.exit(1)
}
console.log('==== 通过：本次改动只动了注释与空白 ====')
