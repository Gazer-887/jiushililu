import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 渲染层回调稳定性守卫（plan49 L3「疫苗」）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 2026-09-19 真机卡顿复发，查出一条**跨进程自持闭环**：
 *
 *   ChatView 订阅 messages → 生成期间高频 set → 本页重渲染
 *     → 内联箭头 onSelectAgent 每次渲染换新引用
 *     → PlusMenu 的 effect 依赖它 → 依赖变，重跑
 *     → refreshAgents() 真打 IPC → 主进程裸读 10 个 agent 文件
 *     → 返回全新对象 → 订阅者重渲染 → 回到第一步
 *
 * 机制本身**由实验确证**（`tests/bench/render-callback-loop.mjs`：内联回调 0.3 秒跑 200 次，
 * 稳定引用只跑 1 次）。它在真机上是不是**那一次**卡顿的主因仍有争议
 * （见 plan49 §2 与复查记录：watchdog 的 crumbs 全落在停滞末段，主因未定），
 * 但**这个闭环是真的、必须拦** —— 否则换个 prop 名就能再来一次。
 *
 * ── 判据（怎么判定"危险"） ───────────────────────────────────────────────────
 * 只对**已声明"依赖该 prop"**的子组件检查 —— 不能一刀切禁掉所有内联回调
 * （那会误伤大量无害写法，把测试变成噪音，最终被人关掉）。
 * 契约表见下 `WATCHED_PROPS`；子组件新增这类依赖时，请把 prop 名加进表里。
 *
 * ── 已知局限（诚实标注，别当安全网用） ───────────────────────────────────────
 * 本文件是**正则/字符串扫描**，不是 AST 分析（仓库没装 babel/ts-morph，vitest 跑 node 环境）。
 * 它能拦住的主要是"字面内联箭头"，对下列形态**力有不逮**：
 *   - 把箭头先赋给变量再传（`const cb = (n) => {}` + `onSelectAgent={cb}`）
 *     —— 已用"定义点回查"缓解：会顺着变量名找它的声明并检查是否 useCallback
 *   - 跨文件 re-export / 高阶函数包装
 * 所以它的定位是**提醒器 + 回归网**，不是形式化证明。发现漏网时请补规则，别关掉它。
 */

const ROOT = process.cwd()
const RENDERER = join(ROOT, 'src/renderer/src')

/**
 * 受监视的 prop 契约：`组件名 → 该组件的某个 effect 依赖数组里含有的 prop 名`。
 *
 * ⚠️ 加新条目时请确认子组件里**确实**把它放进了依赖数组 —— 这张表的语义是
 *    "这个 prop 一变，子组件就会重跑一段副作用"，不是"我觉得它可能敏感"。
 */
const WATCHED_PROPS: ReadonlyArray<{ component: string; prop: string; why: string }> = [
  {
    component: 'PlusMenu',
    prop: 'onSelectAgent',
    why: 'PlusMenu 的 effect 依赖它并在其中调用 refreshAgents()（plan49 的现场）'
  },
  {
    component: 'PlusMenu',
    prop: 'onAttach',
    why: '当前 effect 未依赖它（侥幸安全），但它已在高频重渲染链上 —— 一旦有人给它加 effect 就复发'
  }
]

/** 递归收集 .tsx 文件 */
function collectTsx(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collectTsx(p))
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * 从 `{` 起配对取出花括号内容（返回内层表达式）。
 * 返回 `[表达式, 结束下标]`；找不到配对的 `}` 时返回 `[null, -1]`。
 */
function readBraced(source: string, openIdx: number): [string, number] {
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return [source.slice(openIdx + 1, i), i]
    }
  }
  return ['', -1]
}

/**
 * 收集"某组件的实例标签"里出现的 `prop={表达式}` 写法。
 *
 * 开标签的结束判定：从 `<Component` 起扫，维护花括号深度，深度为 0 时的第一个 `>`
 * 视为标签结束。**深度非 0 时的 `>`（如 `{a > b}`、`{<A/>}`）不会被误判为标签结束。**
 */
function findPropUsages(source: string, component: string, prop: string): string[] {
  const found: string[] = []
  const openRe = new RegExp(`<${component}\\b`, 'g')
  let m: RegExpExecArray | null
  while ((m = openRe.exec(source)) !== null) {
    let i = m.index
    let depth = 0
    let end = -1
    for (; i < source.length; i++) {
      const ch = source[i]!
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) {
        end = i + 1
        break
      }
    }
    if (end < 0) continue
    const tag = source.slice(m.index, end)

    const attrRe = new RegExp(`\\b${prop}\\s*=\\s*\\{`, 'g')
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(tag)) !== null) {
      const openIdx = a.index + a[0].length - 1 // 停在 '{'
      const [expr] = readBraced(tag, openIdx)
      found.push(expr)
    }
  }
  return found
}

/**
 * 检查文件里是否存在该标识符的"裸箭头定义"（`const cb = (n) => {}` / `function cb()` 声明）。
 * 用于堵住"先赋给变量再传"的绕过路径。
 */
function hasUnstableDefinition(source: string, ident: string): boolean {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // const/let/var cb = (...) =>  /  = function
  if (new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`).test(source))
    return true
  if (new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function\\b`).test(source)) return true
  if (new RegExp(`function\\s+${esc}\\s*\\(`).test(source)) return true
  return false
}

/** 该标识符是否在文件里由 useCallback / useMemo 定义 */
function hasStableDefinition(source: string, ident: string): boolean {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*use(?:Callback|Memo)\\s*\\(`).test(source)
}

/**
 * 判定一个表达式是否**保证稳定引用**。
 * `source` 用于"变量回查"：纯标识符要去它自己的定义点看是 useCallback 还是裸箭头。
 */
function isStableExpression(expr: string, source: string): boolean {
  const e = expr.trim().replace(/\s+/g, ' ')
  // 内联箭头 / 内联函数：**这是要拦的目标**
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(e)) return false
  if (/^(async\s+)?function\b/.test(e)) return false
  // useCallback / useMemo 的调用结果
  if (/\buse(Callback|Memo)\s*\(/.test(e)) return true
  // 条件/逻辑表达式：两臂都必须稳定（保守：无法两边都证明就拒绝）
  const ternary = e.match(/^(.+?)\?(.+?):(.+)$/)
  if (ternary) return isStableExpression(ternary[2]!, source) && isStableExpression(ternary[3]!, source)
  // 对象/数组字面量无法保证稳定
  if (/^[[{]/.test(e)) return false
  // 对象属性取值（zustand action 等）；但要先排除它其实是个裸箭头包了一层
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(e)) return true
  // 纯标识符：**必须回查定义点**（这是初版最大的漏洞：无条件放行）
  const ident = e.match(/^[A-Za-z_$][\w$]*$/)
  if (ident) {
    const name = ident[0]
    if (/^set[A-Z]/.test(name)) return true // useState setter 约定
    if (hasUnstableDefinition(source, name)) return false
    if (hasStableDefinition(source, name)) return true
    // 定义不在本文件（import 进来的组件/hook 返回值）：无法证明，**保守拒绝**
    return false
  }
  return false
}

describe('渲染层回调稳定性（plan49 L3 疫苗）', () => {
  const files = collectTsx(RENDERER)

  it('扫描范围非空（防止路径写错导致"空过"）', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  for (const { component, prop, why } of WATCHED_PROPS) {
    it(`${component}.${prop} 的传入值必须稳定引用 —— ${why}`, () => {
      const violations: string[] = []
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        // 跳过子组件自身（它内部当然会引用自己的 prop）
        if (source.includes(`export default function ${component}`)) continue
        for (const expr of findPropUsages(source, component, prop)) {
          if (!isStableExpression(expr, source)) {
            const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
            violations.push(`${rel}：<${component} ${prop}={${expr.trim().slice(0, 70)}}>`)
          }
        }
      }
      expect(
        violations,
        `以下写法把"每次渲染都可能换新引用"的回调传给 ${component}.${prop}，` +
          `而该组件的 effect 依赖它 ⇒ 每次渲染重跑副作用 ⇒ 可能自持闭环（plan49）。\n` +
          `请改用 useCallback / useMemo 包稳，或传稳定的 setter / store action。\n` +
          violations.join('\n')
      ).toEqual([])
    })
  }

  it('本次现场（ChatView → InputConsole → PlusMenu）已修复：不得回退成内联箭头', () => {
    const chatView = readFileSync(join(RENDERER, 'views/ChatView.tsx'), 'utf8')
    const usages = findPropUsages(chatView, 'InputConsole', 'onSelectAgent')
    expect(usages.length, 'ChatView 应当向 InputConsole 传 onSelectAgent').toBeGreaterThan(0)
    for (const expr of usages) {
      expect(isStableExpression(expr, chatView), `ChatView 的 onSelectAgent 不稳定：${expr}`).toBe(true)
    }
    // 组件内必须真有 useCallback 定义（挡住"传了个稳定的别的东西"）
    expect(chatView).toMatch(/const onSelectAgent = useCallback\(/)
  })
})

// ── 下面三条是**判据自测**：保证上面的函数真能分辨好坏，而不是恒真/恒假 ──
describe('判据自测（防止守卫本身失效）', () => {
  const fakeSource = [
    'const good = useCallback(() => {}, [])',
    'const bad = (n) => {}',
    'function bad2() {}',
    'const setThing = useState(1)[1]'
  ].join('\n')

  it('内联箭头判定为不稳定', () => {
    expect(isStableExpression('(name) => { x() }', fakeSource)).toBe(false)
    expect(isStableExpression('async (name) => { x() }', fakeSource)).toBe(false)
    expect(isStableExpression('function () {}', fakeSource)).toBe(false)
  })

  it('useCallback/useMemo 判定为稳定', () => {
    expect(isStableExpression('useCallback(() => {}, [])', fakeSource)).toBe(true)
    expect(isStableExpression('useMemo(() => ({}), [])', fakeSource)).toBe(true)
  })

  it('标识符回查定义点：走 useCallback 的放行，裸箭头的拦下', () => {
    expect(isStableExpression('good', fakeSource)).toBe(true)
    expect(isStableExpression('bad', fakeSource)).toBe(false)
    expect(isStableExpression('bad2', fakeSource)).toBe(false)
    expect(isStableExpression('setThing', fakeSource)).toBe(true)
  })

  it('对象/数组字面量与展开式判定为不稳定（不做兜底放行）', () => {
    expect(isStableExpression('{ onSelectAgent: (n) => {} }', fakeSource)).toBe(false)
  })
})
