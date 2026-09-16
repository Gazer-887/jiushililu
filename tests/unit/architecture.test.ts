import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 架构守卫：单测链路里**不得出现 electron / electron-store**。
// 为什么：CI（Linux）没有 Electron 二进制，被测模块直接或间接依赖 electron 就抛
// `Electron failed to install correctly`；本机装了 Electron 则**静默通过** ——
// 形成"本地绿、CI 红"的假象（本项目真的踩过一次）。走法：从每个测试文件出发沿 import 图
// 向下走，只跟本地模块与 @main/@shared，平台无关、确定性。
//
// 修法（而不是改这条测试）：把纯逻辑抽到不依赖 electron 的模块（参见 store/workspace-core.ts），
// electron 相关装配只留在 src/main/index.ts。

const ROOT = process.cwd()
const BANNED = new Set(['electron', 'electron-store'])

/** 把 import 说明符解析成源码文件路径；非本地模块返回 null */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string | null = null
  if (spec.startsWith('@main/')) base = join(ROOT, 'src/main', spec.slice('@main/'.length))
  else if (spec.startsWith('@shared/')) base = join(ROOT, 'src/shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec)
  if (base === null) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function extractSpecifiers(source: string): string[] {
  const specs: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) specs.push(m[1]!)
  // 纯 side-effect import
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  while ((m = bare.exec(source)) !== null) specs.push(m[1]!)
  return specs
}

/** 走一遍 import 图，返回：链上出现的被禁裸模块 + **访问过的本地文件** */
function walkGraph(entry: string): { violations: string[]; visited: string[] } {
  const violations: string[] = []
  const visited = new Set<string>()
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }]

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)

    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const spec of extractSpecifiers(source)) {
      if (BANNED.has(spec) || spec.startsWith('electron/')) {
        violations.push(`${[...chain.slice(1), file].join(' → ')} → ${spec}`)
        continue
      }
      const next = resolveLocal(spec, file)
      if (next !== null && !visited.has(next)) {
        queue.push({ file: next, chain: [...chain.slice(1), file] })
      }
    }
  }
  return { violations, visited: [...visited] }
}

function findBannedInGraph(entry: string): string[] {
  return walkGraph(entry).violations
}

const TEST_ENTRIES = [
  'tests/unit/agent.test.ts',
  'tests/unit/agent-infra.test.ts',
  'tests/unit/agents-store.test.ts',
  'tests/unit/context.test.ts',
  'tests/unit/conversation-rollback.test.ts',
  'tests/unit/conversations-fs.test.ts',
  'tests/unit/conversations-store.test.ts',
  'tests/unit/edit-tool.test.ts',
  'tests/unit/html-preview.test.ts',
  'tests/unit/chat-concurrency.test.ts',
  'tests/unit/goal.test.ts',
  'tests/unit/mcp-manager.test.ts',
  'tests/unit/memory-contract.test.ts',
  'tests/unit/memory-core.test.ts',
  'tests/unit/memory-fs.test.ts',
  'tests/unit/memory-tools.test.ts',
  'tests/unit/memory-injection.test.ts',
  'tests/unit/memory-conflict.test.ts',
  'tests/unit/memory-reflection.test.ts',
  'tests/unit/memory-queue.test.ts',
  'tests/unit/usage-kind.test.ts',
  'tests/unit/plan-approval.test.ts',
  'tests/unit/path-access.test.ts',
  'tests/unit/playbook-core.test.ts',
  'tests/unit/playbook-inject.test.ts',
  'tests/unit/playbook-tools.test.ts',
  'tests/unit/playbook-wiring.test.ts',
  'tests/unit/model-profiles.test.ts',
  'tests/unit/model-source.test.ts',
  'tests/unit/usage.test.ts',
  'tests/unit/providers.test.ts',
  'tests/unit/retrieval.test.ts',
  'tests/unit/rules.test.ts',
  'tests/unit/runner.test.ts',
  'tests/unit/schemas.test.ts',
  'tests/unit/skill-tools.test.ts',
  'tests/unit/stream-guard.test.ts',
  'tests/unit/stream-guard-wiring.test.ts',
  'tests/unit/skills.test.ts',
  'tests/unit/system-web-tools.test.ts',
  'tests/unit/system-integration.test.ts',
  'tests/unit/tokens.test.ts'
]

describe('架构守卫：单测链路不得依赖 electron', () => {
  it.each(TEST_ENTRIES)('%s 的 import 图里没有 electron / electron-store', (entry) => {
    const violations = findBannedInGraph(join(ROOT, entry))
    expect(violations, `发现 electron 依赖（会在 CI 上炸）：\n${violations.join('\n')}`).toEqual([])
  })

  it('守卫本身有效：若模块直接依赖 electron-store 能被抓出', () => {
    // 用项目里真实存在的 store 层做反向验证（它确实依赖 electron-store）
    const violations = findBannedInGraph(join(ROOT, 'src/main/store/workspace.ts'))
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain('electron-store')
  })

  it('守卫**不是空转**：每个入口都真的走进了 src/ 源码（防"改名后守卫静默变空"）', () => {
    // `walkGraph` 读不到入口文件时会 `continue` → 空 violations：**文件被改名/挪走后守卫静默通过**。
    // 所以额外断言每个入口的 import 图里**必须**有 src/ 源码（"恰好不算错的口径只会拿到恰好是假的绿灯"）。
    for (const entry of TEST_ENTRIES) {
      const { visited } = walkGraph(join(ROOT, entry))
      expect(
        visited.some((f) => f.startsWith(join(ROOT, 'src'))),
        `${entry} 的 import 图里没有任何 src/ 源码 —— 守卫正在空转`
      ).toBe(true)
    }
  })

  it('会话存储的基线测试确实覆盖到了 conversations-core（不是空过）', () => {
    const { visited } = walkGraph(join(ROOT, 'tests/unit/conversations-store.test.ts'))
    expect(visited).toContain(join(ROOT, 'src/main/store/conversations-core.ts'))
  })
})

// ── 守卫乙：记忆不得触及权限（plan19 §3.3 / D-042）─────────────────────────
// 为什么单独立一条而**不复用上面的 BANNED**：那个集合只有 electron / electron-store，
// 往 TEST_ENTRIES 里加一行**不会**让"记忆不得碰 settings"被断言 —— 把两件事混成一条，
// 得到的正是"判据天生为绿、防线静默缺失"。故：独立目标 + 自己的反向验证。

/** 沿 import 图找"链上是否到达某个本地文件"，返回到达的调用链（空数组 = 没到达） */
function findReachable(entry: string, target: string): string[] {
  const hits: string[] = []
  const visited = new Set<string>()
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [] }]

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)

    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const spec of extractSpecifiers(source)) {
      const next = resolveLocal(spec, file)
      if (next === null) continue
      const nextChain = [...chain, file]
      if (next === target) {
        hits.push([...nextChain, next].join(' → '))
        continue
      }
      if (!visited.has(next)) queue.push({ file: next, chain: nextChain })
    }
  }
  return hits
}

const SETTINGS_MODULE = join(ROOT, 'src/main/store/settings.ts')

describe('守卫乙：记忆层不得触及权限档', () => {
  const MEMORY_ROOTS = [
    'src/main/memory/memory-core.ts',
    'src/main/memory/inject.ts',
    // 批 2：反思执行器也是纯逻辑，不碰 settings（守卫乙覆盖）
    'src/main/memory/reflection.ts',
    // 批 3：Playbook 纯逻辑与注入，不碰 settings（守卫乙覆盖）
    'src/main/memory/playbook-core.ts',
    'src/main/memory/playbook-inject.ts'
  ]

  it.each(MEMORY_ROOTS)('%s 的 import 图里不出现 store/settings', (entry) => {
    const hits = findReachable(join(ROOT, entry), SETTINGS_MODULE)
    expect(hits, `记忆层获得了改权限的通路：\n${hits.join('\n')}`).toEqual([])
  })

  it('守卫乙**不是空转**：真会 import settings 的模块必须被抓出', () => {
    // 反面验证。没有这一步，守卫乙可能永远绿 —— 而"永远绿的守卫"比没有守卫更危险。
    const hits = findReachable(join(ROOT, 'src/main/ipc.ts'), SETTINGS_MODULE)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toContain('settings.ts')
  })

  it('守卫乙的对象覆盖到了真实记忆模块（防"改名后静默变空"）', () => {
    for (const entry of MEMORY_ROOTS) {
      expect(readFileSync(join(ROOT, entry), 'utf8').length, entry).toBeGreaterThan(0)
    }
  })
})

// ── 守卫丙：通路 B 不经过模型（plan19 §九 批 1 · 判据 3）─────────────────
// 为什么单独立一条：通路 B（选中即记）的全部价值就在"**没有模型参与**"——
// 结构上安全、提示注入够不着它、证据是原话。而"它不调模型"是个**口头约定**，
// 谁哪天为了"顺手补个摘要" import 一下 provider，这条价值就没了，且不会有人发现。

describe('守卫丙：通路 B 不得经过模型', () => {
  const CAPTURE_ENTRY = 'src/renderer/src/components/MemoryCapture.tsx'
  const MODEL_MODULE = /[\\/]providers[\\/]|[\\/]agent[\\/]/

  it('MemoryCapture 的 import 图里不出现 providers / agent 模块', () => {
    const bad = walkGraph(join(ROOT, CAPTURE_ENTRY)).visited.filter((f) => MODEL_MODULE.test(f))
    expect(bad, `通路 B 拿到了模型通路：\n${bad.join('\n')}`).toEqual([])
  })

  it('守卫丙**不是空转**：真会 import provider 的模块必须被抓出', () => {
    const visited = walkGraph(join(ROOT, 'src/main/agent/runner.ts')).visited
    expect(visited.some((f) => MODEL_MODULE.test(f))).toBe(true)
  })

  it('守卫丙的对象确实存在（防改名后静默变空）', () => {
    expect(readFileSync(join(ROOT, CAPTURE_ENTRY), 'utf8').length).toBeGreaterThan(0)
  })
})

// ── 守卫丁：计划批准闸不得下沉进主循环（plan27）───────────────────────────
// 为什么单独立一条：闸现在是挂在 `runAgent` 上的 —— 这条位置的**全部价值**在于
// 「子代理走 `scheduler.ts` 的 `runAgentLoop`，根本不进 `runAgent`」，所以子代理天然不会被卡住等批准。
//
// 而「把闸挪到 `runAgentLoop`」看起来是个**很合理**的重构（"循环结束的地方不正是收尾的地方吗"），
// 一旦挪下去：**每个子代理跑完都会被弹一张批准卡**，父轮次集体挂起等人点头 ——
// 而现有测试一条都不会变红（单测里不注入桥，闸静默失效）。这种"看着对、代价大、无声"的改动
// 正是架构守卫该拦的东西，故用结构断言钉死：**主循环不得认识批准桥**。

describe('守卫丁：批准闸不得下沉进主循环', () => {
  const LOOP = 'src/main/agent/loop.ts'

  it(`${LOOP} 不得引用批准桥（否则子代理会被卡住等批准）`, () => {
    const source = readFileSync(join(ROOT, LOOP), 'utf8')
    expect(source).not.toContain('plan-approval')
    expect(source).not.toContain('planApproval')
    expect(source).not.toContain('PlanApproval')
  })

  it('守卫丁**不是空转**：闸确实活在 runner 里（否则这条守的是个不存在的东西）', () => {
    // 反面验证：若哪天闸被整个删掉，上面那条会**永久绿灯**。所以必须同时断言它还在。
    const runner = readFileSync(join(ROOT, 'src/main/agent/runner.ts'), 'utf8')
    expect(runner).toContain("from './plan-approval'") // 真的引了桥
    expect(runner).toContain('planApproval') // 真的有这个通路
    expect(runner).toContain('skipPlanApproval') // 真的有防套娃开关
  })

  it('子代理入口（scheduler）不得自己实现批准等待（那等于绕过 runner 的单一闸位）', () => {
    const scheduler = readFileSync(join(ROOT, 'src/main/agent/scheduler.ts'), 'utf8')
    expect(scheduler).not.toContain('planApproval')
    expect(scheduler).not.toContain('PlanApproval')
  })
})
