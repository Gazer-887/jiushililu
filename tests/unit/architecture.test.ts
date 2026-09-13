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
  'tests/unit/context.test.ts',
  'tests/unit/conversation-rollback.test.ts',
  'tests/unit/conversations-fs.test.ts',
  'tests/unit/conversations-store.test.ts',
  'tests/unit/html-preview.test.ts',
  'tests/unit/chat-concurrency.test.ts',
  'tests/unit/goal.test.ts',
  'tests/unit/model-profiles.test.ts',
  'tests/unit/model-source.test.ts',
  'tests/unit/usage.test.ts',
  'tests/unit/providers.test.ts',
  'tests/unit/runner.test.ts',
  'tests/unit/schemas.test.ts',
  'tests/unit/system-web-tools.test.ts',
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
