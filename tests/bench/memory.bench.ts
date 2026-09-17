import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { createMemoryRepo } from '@main/memory/memory-core'
import { createFsMemoryBackend } from '@main/store/memory-fs'

// 记忆批 bench（plan19 批 1 **判据 10**）：装配层**每轮重读盘**重组注入段 —— 这笔成本必须测出来，
// 否则"感觉慢了就加缓存"就会重演（§4.3 明文：判据先登记，才准加缓存）。
//
// 跑法（显式跑，**不进 CI** —— 阈值是耗时，CI 上会抖；本项目有"CI 平台差异连红 5 次"的前科）：
//   npm run bench
//
// **环境规格（判据 10 原文，plan18 §八 18-A 判据 8 折入项）**：
//   本机 NVMe · 主进程内（同一进程直接调 repo，不走 IPC）· 热缓存（先跑一轮再计时）·
//   100 条（= `MEMORY_LIMITS.maxEntries` 满载）· 多次取样取**中位数**。
//
// ⚠️ **判据先登记、再跑**：阈值写死在下面、脚本自己出 PASS/FAIL。
//    首跑用于**取值**（§十二 那个"待填"），取完把阈值收紧成"实测中位数 × 3"的回归警报——
//    它不是性能声明，是"读盘成本悄悄变贵"的警报。这个先后顺序是 plan19 §十二 自己写明的。

const THRESHOLDS = {
  /** 100 条满载 `list()` 中位数。**首跑实测 14.29ms**（2026-09-15，本机 NVMe·热缓存·30 取样），
   *  按协议收紧为实测 ×3 ≈ 45ms —— 它是"读盘成本悄悄变贵"的回归警报，不是性能声明 */
  listP50Ms: 45,
  /** 100 条满载 `save()`（编辑既有条目，含原子写 + fsync）中位数。**首跑实测 25.50ms** → ×3 ≈ 80ms */
  saveP50Ms: 80
}

const N = 100
const SAMPLES = 30

const roots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-mem-bench-'))
  roots.push(dir)
  return dir
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

describe('记忆层读盘成本（判据 10）', () => {
  it(`100 条满载：list() 中位数 ≤ ${THRESHOLDS.listP50Ms}ms、save() 中位数 ≤ ${THRESHOLDS.saveP50Ms}ms`, () => {
    const root = tmpRoot()
    const repo = createMemoryRepo(
      createFsMemoryBackend(root),
      { onWarn: () => {}, conversationId: () => 'bench' }
    )

    // 播种：满载 100 条（达到上限，也正是"每轮都要全量重读"的最坏情况）。
    // force 是必须的：plan33 相似闸门会把 entry-000..099 这类顺序命名判为"高度相似"而拒新建；
    // 播种只是造满载环境，不在被测路径上（被测 save 走"编辑既有条目"，不经该闸门）。
    for (let i = 0; i < N; i += 1) {
      const r = repo.save({
        name: `entry-${String(i).padStart(3, '0')}`,
        description: `第 ${i} 条记忆的摘要，长度接近真实使用（约三十个字）。`,
        class: i % 3 === 0 ? 'style' : i % 3 === 1 ? 'default' : 'knowledge',
        body: '正文。'.repeat(12),
        force: true
      })
      if (!r.ok) throw new Error(`播种失败：${r.reason}`)
    }

    // 热缓存：先跑两轮不计入（页缓存 warm up，判据 10 的环境规格之一）
    repo.list()
    repo.list()

    const listSamples: number[] = []
    let injected = 0
    for (let i = 0; i < SAMPLES; i += 1) {
      const t0 = performance.now()
      const idx = repo.list()
      listSamples.push(performance.now() - t0)
      // 满载 100 条时**字节预算先到**（8KB 只装得下约 81 条）—— 这是设计内行为，
      // 真正的不变量是"每一条都有去处"：注入的 + 如实报出的 omitted == 总数
      injected = idx.entries.length
      if (injected + idx.omitted !== N) {
        throw new Error(`条目有去无回：注入 ${injected} + omitted ${idx.omitted} ≠ ${N}`)
      }
    }

    const saveSamples: number[] = []
    // 编辑**既有**条目而不是新建：满载 100 条时硬上限会拒新建（那正是它该干的），
    // 而编辑才是真实热路径 —— 且照样走原子写 + fsync，量的不是空转。
    // ⚠️ name 必须与被编辑条目同名（写后校验按名字键找条目，改名编辑会被拒）
    const editTarget = repo.listFiles()[0]!
    for (let i = 0; i < SAMPLES; i += 1) {
      const t0 = performance.now()
      const r = repo.save({
        name: 'entry-000',
        description: `第 0 条记忆的摘要（bench 编辑第 ${i} 次）。`,
        class: 'style',
        body: `bench 正文 ${i}。`.repeat(6),
        origin: 'user',
        evidence: { conversationId: 'bench', turnIndex: i },
        file: editTarget
      })
      saveSamples.push(performance.now() - t0)
      if (!r.ok) throw new Error(`save 失败：${r.reason}`)
    }

    const sortedList = [...listSamples].sort((a, b) => a - b)
    const sortedSave = [...saveSamples].sort((a, b) => a - b)
    const listP50 = median(sortedList)
    const saveP50 = median(sortedSave)
    // 显式打出实测值 —— 取值与回填 §十二 都以这次输出为准
    console.log(
      `MEMORY_BENCH list p50=${listP50.toFixed(2)}ms p95=${sortedList[Math.floor(sortedList.length * 0.95)]?.toFixed(2)}ms | save p50=${saveP50.toFixed(2)}ms | ${N} 条满载注入 ${injected} 条（字节预算截断 omitted=${N - injected}）· ${SAMPLES} 次取样 · 热缓存`
    )

    if (listP50 > THRESHOLDS.listP50Ms) {
      throw new Error(
        `list() 中位数 ${listP50.toFixed(2)}ms 超过登记阈值 ${THRESHOLDS.listP50Ms}ms —— 先查"是不是把全量读变成了逐条读"，再谈加缓存`
      )
    }
    if (saveP50 > THRESHOLDS.saveP50Ms) {
      throw new Error(
        `save() 中位数 ${saveP50.toFixed(2)}ms 超过登记阈值 ${THRESHOLDS.saveP50Ms}ms —— 原子写 + fsync 是底线，不许为省这点时间拆掉`
      )
    }

    rmSync(root, { recursive: true, force: true })
  })
})
