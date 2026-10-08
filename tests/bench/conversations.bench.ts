import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation } from '@shared/ipc'
import { createConversationsRepo } from '@main/store/conversations-core'
import { createFsConversationsBackend } from '@main/store/conversations-fs'
import {
  formatViolations,
  percentileR7,
  thresholdViolations,
  type BenchmarkMetrics
} from '../helpers/benchmark-metrics'

// plan10 A 批第三块：**测量定引擎**（plan8 R8 的正题）。
// 跑法（显式跑，**不进 CI** —— 阈值是耗时，CI 上会抖）：
//   node node_modules/vitest/vitest.mjs run --config config/vitest.bench.config.ts tests/bench/conversations.bench.ts --pool=forks --maxWorkers=1 --minWorkers=1
//   注意不是 config/vitest.config.ts —— 那份 include 只有 tests/unit，bench 匹配不到
// 堆增量要可信，前提是 **Vitest 工作进程**持有 global.gc；本文件以脚本内自测的 gcEnabled 为准，
// 不可用即**普通三档直接抛错**，不产出任何性能结论（本机 2026-10-08 / vitest 2.1.9 实测：
// 父进程 node --expose-gc 未传到 forks worker；临时进程环境变量 NODE_OPTIONS=--expose-gc 时自测为 true。
// 已安装 vitest 源码 resolveConfig 内存在 poolOptions.execArgv，CLI 帮助未展示不等于该能力不存在）。
//
// ⚠️ **判据先登记、再跑**（plan10 §2.3）：阈值写死在下面、脚本自己出判定，
//    不允许"跑完看数据再挑一个好看的说法"。
// ⚠️ 下面那份旧实现是**对照基线**（整表读+整表写、正文内嵌），不是产品代码 ——
//    不对比就答不出"分层换来了什么"与"JSON 还够不够快"。

/** 预登记阈值：任一超标 → 阈值触发，**交回评估**（是否迁移由用户裁决，脚本不自动决定） */
const THRESHOLDS = {
  listP95Ms: 50,
  saveP95Ms: 50,
  /** 列表一次调用造成的堆增量（正文被整表拉进内存的话会爆掉这一条） */
  listHeapDeltaMB: 20
}

const SCALES = [
  { name: '真实量级 3×18', n: 3, m: 18, runs: 20 },
  { name: 'R8 口径 200×50', n: 200, m: 50, runs: 20 },
  { name: '极端 1000×50', n: 1000, m: 50, runs: 5 }
]

const roots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-bench-'))
  roots.push(dir)
  return dir
}

function msg(i: number): ChatMessage {
  return { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条消息，写长一点让量级真实。`.repeat(6) }
}

// ⚠️ **旧统计口径（R1 专用，未纳入本轮 R7 修复）**：用 floor(p/100×n) 作零基下标。
// 20 个样本时 P95 落到下标 19，也就是**最大样本**——它不是 R7 P95。
// 保留它只为让同文件的 R1 巨型档维持原样本数、原阈值与原判词；普通三档不再用它。
const legacyIndexPct = (sorted: number[], p: number): number => {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

function legacyStats(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50: legacyIndexPct(sorted, 50), p95: legacyIndexPct(sorted, 95) }
}

/** 本轮普通三档统一用 R7；max 单列，因为 max 才揭示旧 floor 下标实际取到的那一端 */
const r7 = (samples: readonly number[], p: number): number => percentileR7(samples, p)
const maxOf = (samples: readonly number[]): number => Math.max(...samples)

/** 人读摘要的显示精度样本行：只给人看，**不能**据此复算判词（截精后原值不可还原） */
const displaySampleLine = (samples: readonly number[]): string =>
  `[${samples.map((v) => v.toFixed(4)).join(', ')}]`

// ===== 无损 JSON 证据 =====
// 固定前缀让第三方能机械抽取：不解析控制台排版，只按前缀找行；数值直接 JSON.stringify，
// 不先 toFixed —— 判词用的是未舍入值，证据也必须是未舍入值，否则边界（如 49.99999）无法复算。
const EVIDENCE_PREFIX = 'JSL_BENCH_EVIDENCE_JSON'

/** 运行身份：外部传 JSL_BENCH_RUN_ID 让日志与运行一一对应；未传则现场生成，不复用旧 ID */
const RUN_ID =
  process.env.JSL_BENCH_RUN_ID ?? `r8-${process.pid}-${new Date().toISOString().replace(/[:.]/g, '-')}`

/** 证据落盘目录（可选）：传 JSL_BENCH_EVIDENCE_DIR 则每档另存一份独立 JSON，**不覆盖**旧运行 */
const EVIDENCE_DIR = process.env.JSL_BENCH_EVIDENCE_DIR ?? null

interface ScaleEvidence {
  kind: 'jsl-bench-evidence'
  version: 1
  runId: string
  scale: { name: string; n: number; m: number; runs: number }
  env: { node: string; platform: string; arch: string; gcEnabled: boolean }
  algorithm: 'R7'
  samples: {
    newList: number[]
    oldList: number[]
    newSave: number[]
    oldSave: number[]
  }
  stats: {
    newList: { p95: number; max: number }
    oldList: { p95: number; max: number }
    newSave: { p95: number; max: number }
    oldSave: { p95: number; max: number }
  }
  heapMB: { new: number; old: number }
  thresholds: typeof THRESHOLDS
  metrics: BenchmarkMetrics
  violations: ReturnType<typeof thresholdViolations>
  bytes: { newIndex: number; newBodyApprox: number; oldWhole: number }
}

/** 输出并（可选）落盘一条无损证据；落盘失败只记一行，不掩盖已打印的行 */
const emitEvidence = (record: unknown, fileName: string): void => {
  console.log(`${EVIDENCE_PREFIX} ${JSON.stringify(record)}`)
  if (!EVIDENCE_DIR) return
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, fileName), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.log(`${EVIDENCE_PREFIX} {"kind":"jsl-bench-evidence-write-failed","file":"${fileName}","error":"${String(err)}"}`)
  }
}

// 旧口径的等价复刻（对照基线）：整表读 + 整表写，正文内嵌
function oldSeed(root: string, n: number, m: number): void {
  const conversations: Record<string, Conversation> = {}
  for (let i = 0; i < n; i += 1) {
    const id = `c${String(i).padStart(4, '0')}`
    const messages = Array.from({ length: m }, (_, k) => msg(k))
    conversations[id] = {
      id,
      title: `会话 ${i}`,
      workspace: 'D:/ws',
      model: 'm',
      skills: [],
      createdAt: 1,
      updatedAt: 1,
      messageCount: m,
      messages
    }
  }
  writeFileSync(join(root, 'old.json'), JSON.stringify({ conversations }), 'utf8')
}

function oldList(root: string): number {
  const raw = JSON.parse(readFileSync(join(root, 'old.json'), 'utf8')) as {
    conversations: Record<string, Conversation>
  }
  // 与旧实现同口径：每条都要展开 messages 才能算出 messageCount
  return Object.values(raw.conversations).map((c) => {
    const { messages, ...meta } = c
    return { ...meta, messageCount: messages.length }
  }).length
}

function oldSave(root: string, id: string, messages: ChatMessage[]): void {
  const path = join(root, 'old.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { conversations: Record<string, Conversation> }
  raw.conversations[id] = { ...raw.conversations[id]!, messages, messageCount: messages.length }
  // 旧实现：**整表重写**
  writeFileSync(path, JSON.stringify(raw), 'utf8')
}

const mb = (bytes: number): number => bytes / 1024 / 1024

// ===== plan10 R1 缺口补测：单会话巨型文件档 =====
// 背景（plan8 R8 补记 / plan10 §四 R1）：回滚「追加+指针」生效后，单会话正文文件只增不减，
// 每次保存都是 JSON.stringify 整份原子重写。R8 测量只覆盖「多会话×小文件」，
// 单会话巨型档（10MB 级）此前只有估算（save 100-300ms + 瞬时内存 2-3 倍），本档实测验证。
// 为什么不需要旧实现对照：单会话场景下旧整表实现重写的也是同一份大小（分层无增益可言），
// R1 关心的是新实现自身「文件越长、保存越贵」的曲线。

/** 预登记判定（跑之前写死）：10MB 档 save P95 > 500ms 或堆增量 > 6 倍文件 → 分片追加应尽快立项 */
const GIANT_THRESHOLDS = {
  giant10MBSaveP95Ms: 500,
  giant10MBHeapRatio: 6
}

const GIANT_SCALES = [
  { name: '巨型 1MB', targetBytes: 1 * 1024 * 1024, runs: 10 },
  { name: '巨型 5MB', targetBytes: 5 * 1024 * 1024, runs: 8 },
  { name: '巨型 10MB', targetBytes: 10 * 1024 * 1024, runs: 6 }
]

/** 造一条「长工具输出」消息（模拟真实会话里读文件/命令输出整段进上下文） */
function giantMsg(i: number): ChatMessage {
  const filler = '工具输出样例'.repeat(340) // 约 6KB UTF-8
  return { role: i % 2 === 0 ? 'user' : 'assistant', content: `#${i} 带长输出的消息\n` + filler }
}

/** 造到约 targetBytes 为止的消息数组（单条探测 + 一次校准补齐，不搞 O(n²)） */
function makeGiantMessages(targetBytes: number): ChatMessage[] {
  const perMsg = Buffer.byteLength(JSON.stringify(giantMsg(0), null, 2), 'utf8')
  const n = Math.max(1, Math.ceil(targetBytes / perMsg))
  const messages = Array.from({ length: n }, (_, i) => giantMsg(i))
  const actual = Buffer.byteLength(JSON.stringify(messages, null, 2), 'utf8')
  if (actual < targetBytes) {
    const more = Math.ceil((targetBytes - actual) / perMsg)
    for (let i = 0; i < more; i += 1) messages.push(giantMsg(n + i))
  }
  return messages
}

describe('会话存储：分层前后 + 引擎结论', () => {
  it(
    '测量三档量级：列表 / 保存 / 列表堆增量（新旧对照）',
    () => {
      const rows: string[] = []
      const evidence: string[] = []
      const scaleViolations: { scale: string; violations: ReturnType<typeof thresholdViolations> }[] = []
      let verdictFail = false
      // GC 以**测试工作进程**实测为准，不能只看父进程的启动参数
      const gcEnabled = typeof global.gc === 'function'
      const env = {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        gcEnabled
      }

      console.log(
        `\n===== 运行环境（Vitest 工作进程内自测）=====\n` +
          `node=${process.version} platform=${process.platform}/${process.arch} gcEnabled=${String(gcEnabled)} runId=${RUN_ID}`
      )

      // ⚠️ 环境闸必须在**造数据与任何性能采样之前**：堆增量没有 GC 就不是可比证据。
      // 缺 GC 时只警告却继续跑，会让「三项通过/本轮未触发」在无效环境下照样打印 —— 那是假绿。
      if (!gcEnabled) {
        const error = {
          kind: 'jsl-bench-env-error',
          version: 1,
          runId: RUN_ID,
          env,
          error: {
            code: 'GC_UNAVAILABLE',
            message: 'Vitest 工作进程内 global.gc 不是函数；堆增量不可比，本次不产出任何性能结论',
            hint: '本机实测可用启动方式：临时进程环境变量 NODE_OPTIONS=--expose-gc，并以脚本自测 gcEnabled=true 为准'
          },
          validPerformanceResult: false
        }
        console.log(`\n===== 环境错误：global.gc 不可用，本次不测量 =====`)
        emitEvidence(error, `${RUN_ID}-env-error.json`)
        throw new Error(
          `环境不满足：Vitest 工作进程内 global.gc 不可用（node=${process.version} ${process.platform}/${process.arch}）。` +
            '堆增量不在未回收垃圾上测量则不可比，本次不产出性能结论，请用带 GC 的启动方式重跑。'
        )
      }

      for (const scale of SCALES) {
        const root = tmpRoot()
        const newOnDisk = join(root, 'new')

        // 造数据（新实现）
        const seeder = createConversationsRepo(createFsConversationsBackend(newOnDisk))
        for (let i = 0; i < scale.n; i += 1) {
          const id = `c${String(i).padStart(4, '0')}`
          const messages = Array.from({ length: scale.m }, (_, k) => msg(k))
          // 直接走 backend 灌数据（走 repo 也行，这里只为把规模堆起来）
          const backend = createFsConversationsBackend(newOnDisk)
          backend.writeMessages(id, messages)
          backend.putMeta(id, {
            id,
            title: `会话 ${i}`,
            workspace: 'D:/ws',
            model: 'm',
            skills: [],
            createdAt: 1,
            updatedAt: 1,
            messageCount: scale.m
          })
        }
        void seeder
        oldSeed(root, scale.n, scale.m)

        const newBytes = statSync(join(newOnDisk, 'conversations.json')).size
        const bodyBytes = statSync(join(newOnDisk, 'conversations', 'c0000.json')).size * scale.n
        const oldBytes = statSync(join(root, 'old.json')).size

        // 列表：每次都用全新的 backend/repo，避免任何内存缓存影响
        const newListSamples: number[] = []
        for (let k = 0; k < scale.runs; k += 1) {
          const repo = createConversationsRepo(createFsConversationsBackend(newOnDisk))
          const t0 = performance.now()
          repo.listConversations()
          newListSamples.push(performance.now() - t0)
        }
        const oldListSamples: number[] = []
        for (let k = 0; k < scale.runs; k += 1) {
          const t0 = performance.now()
          oldList(root)
          oldListSamples.push(performance.now() - t0)
        }
        const listRuns = newListSamples.length
        const oldListRuns = oldListSamples.length
        if (listRuns !== scale.runs || oldListRuns !== scale.runs) {
          throw new Error(
            `档位「${scale.name}」list 采样不完整：新 ${listRuns} 旧 ${oldListRuns}，期望各 ${scale.runs}`
          )
        }

        // 保存：改中间那条会话
        const saveId = `c${String(Math.floor(scale.n / 2)).padStart(4, '0')}`
        const newSaveSamples: number[] = []
        for (let k = 0; k < scale.runs; k += 1) {
          const repo = createConversationsRepo(createFsConversationsBackend(newOnDisk))
          const t0 = performance.now()
          repo.saveConversation(saveId, Array.from({ length: scale.m }, (_, j) => msg(j)))
          newSaveSamples.push(performance.now() - t0)
        }
        const oldSaveSamples: number[] = []
        for (let k = 0; k < scale.runs; k += 1) {
          const t0 = performance.now()
          oldSave(root, saveId, Array.from({ length: scale.m }, (_, j) => msg(j)))
          oldSaveSamples.push(performance.now() - t0)
        }
        const saveRuns = newSaveSamples.length
        const oldSaveRuns = oldSaveSamples.length
        if (saveRuns !== scale.runs || oldSaveRuns !== scale.runs) {
          throw new Error(
            `档位「${scale.name}」save 采样不完整：新 ${saveRuns} 旧 ${oldSaveRuns}，期望各 ${scale.runs}`
          )
        }

        // 列表堆增量："会不会把正文整个拉进内存"。单位口径：bytes / 1024 / 1024 = MiB（下称 MB）。
        const heapOf = (fn: () => void): number => {
          global.gc?.()
          const before = process.memoryUsage().heapUsed
          fn()
          return mb(process.memoryUsage().heapUsed - before)
        }
        const newHeap = heapOf(() =>
          createConversationsRepo(createFsConversationsBackend(newOnDisk)).listConversations()
        )
        const oldHeap = heapOf(() => oldList(root))

        // 新旧两套实现都用 R7 统计，口径一致才可比；旧实现只作对照，不参与失败判定。
        const metrics: BenchmarkMetrics = {
          listP95Ms: r7(newListSamples, 95),
          saveP95Ms: r7(newSaveSamples, 95),
          listHeapDeltaMB: newHeap
        }
        const violations = thresholdViolations(metrics, THRESHOLDS)
        if (violations.length > 0) verdictFail = true

        // 无损证据先落地：采样一结束就输出，判词与断言都在它之后
        emitEvidence(
          {
            kind: 'jsl-bench-evidence',
            version: 1,
            runId: RUN_ID,
            scale: { name: scale.name, n: scale.n, m: scale.m, runs: scale.runs },
            env,
            algorithm: 'R7',
            samples: {
              newList: newListSamples,
              oldList: oldListSamples,
              newSave: newSaveSamples,
              oldSave: oldSaveSamples
            },
            stats: {
              newList: { p95: metrics.listP95Ms, max: maxOf(newListSamples) },
              oldList: { p95: r7(oldListSamples, 95), max: maxOf(oldListSamples) },
              newSave: { p95: metrics.saveP95Ms, max: maxOf(newSaveSamples) },
              oldSave: { p95: r7(oldSaveSamples, 95), max: maxOf(oldSaveSamples) }
            },
            heapMB: { new: newHeap, old: oldHeap },
            thresholds: THRESHOLDS,
            metrics,
            violations,
            bytes: { newIndex: newBytes, newBodyApprox: bodyBytes, oldWhole: oldBytes }
          } satisfies ScaleEvidence,
          `${RUN_ID}-${scale.name}.json`
        )

        rows.push(
          [
            scale.name,
            `list 新 R7P95 ${metrics.listP95Ms.toFixed(2)}ms / max ${maxOf(newListSamples).toFixed(2)}ms（n=${listRuns}）`,
            `list 旧 R7P95 ${r7(oldListSamples, 95).toFixed(2)}ms / max ${maxOf(oldListSamples).toFixed(2)}ms（n=${oldListRuns}）`,
            `save 新 R7P95 ${metrics.saveP95Ms.toFixed(2)}ms / max ${maxOf(newSaveSamples).toFixed(2)}ms（n=${saveRuns}）`,
            `save 旧 R7P95 ${r7(oldSaveSamples, 95).toFixed(2)}ms / max ${maxOf(oldSaveSamples).toFixed(2)}ms（n=${oldSaveRuns}）`,
            `list 堆增量 新 ${newHeap.toFixed(2)}MB / 旧 ${oldHeap.toFixed(2)}MB（MiB）`,
            `索引 ${newBytes}B vs 正文约 ${mb(bodyBytes).toFixed(1)}MB（旧整表 ${mb(oldBytes).toFixed(1)}MB）`,
            `阈值 list P95<${THRESHOLDS.listP95Ms}ms save P95<${THRESHOLDS.saveP95Ms}ms heap<${THRESHOLDS.listHeapDeltaMB}MB（严格小于）`,
            `新实现判定：${violations.length === 0 ? '三项均通过' : `超线 ${formatViolations(violations)}`}（旧实现仅对照，不判失败）`
          ].join(' | ')
        )
        evidence.push(
          [
            '',
            `──── 档位「${scale.name}」（n=${scale.n} × m=${scale.m}，runs=${scale.runs}）────`,
            `新 list 样本(ms)：${displaySampleLine(newListSamples)}`,
            `旧 list 样本(ms)：${displaySampleLine(oldListSamples)}`,
            `新 save 样本(ms)：${displaySampleLine(newSaveSamples)}`,
            `旧 save 样本(ms)：${displaySampleLine(oldSaveSamples)}`,
            `新 list R7P95=${metrics.listP95Ms.toFixed(4)}ms max=${maxOf(newListSamples).toFixed(4)}ms`,
            `新 save R7P95=${metrics.saveP95Ms.toFixed(4)}ms max=${maxOf(newSaveSamples).toFixed(4)}ms`,
            `旧 list R7P95=${r7(oldListSamples, 95).toFixed(4)}ms max=${maxOf(oldListSamples).toFixed(4)}ms`,
            `旧 save R7P95=${r7(oldSaveSamples, 95).toFixed(4)}ms max=${maxOf(oldSaveSamples).toFixed(4)}ms`,
            `list heap 新=${newHeap.toFixed(4)}MB 旧=${oldHeap.toFixed(4)}MB（gcEnabled=${String(gcEnabled)}）`,
            `逐项判定：` +
              [
                `list P95 ${metrics.listP95Ms.toFixed(4)} < ${THRESHOLDS.listP95Ms} → ${metrics.listP95Ms < THRESHOLDS.listP95Ms ? '通过' : '超线'}`,
                `save P95 ${metrics.saveP95Ms.toFixed(4)} < ${THRESHOLDS.saveP95Ms} → ${metrics.saveP95Ms < THRESHOLDS.saveP95Ms ? '通过' : '超线'}`,
                `heap ${newHeap.toFixed(4)} < ${THRESHOLDS.listHeapDeltaMB} → ${newHeap < THRESHOLDS.listHeapDeltaMB ? '通过' : '超线'}`
              ].join('；')
          ].join('\n')
        )
        scaleViolations.push({ scale: scale.name, violations })
      }

      console.log('\n===== 测量结果（预登记阈值：list/save P95 < 50ms，列表堆增量 < 20MB；统计口径 R7）=====')
      for (const r of rows) console.log('· ' + r)
      console.log('\n===== 人读摘要（以下为显示精度四位小数；无损复算请取 JSL_BENCH_EVIDENCE_JSON 行）=====')
      for (const e of evidence) console.log(e)
      // 判词只说"阈值是否触发"，不替用户裁决存储引擎
      console.log(
        `\n===== 阈值判定：${verdictFail ? '阈值触发，交回评估（是否迁移由用户裁决，本脚本不自动决定）' : '本轮未触发（三项新实现指标均低于预登记阈值）'} =====\n`
      )

      // 所有采样与证据打印完成后，再让超线进入真实失败路径
      const failed = scaleViolations.filter((s) => s.violations.length > 0)
      if (failed.length > 0) {
        const detail = failed
          .map((s) => `档位「${s.scale}」${formatViolations(s.violations)}`)
          .join('；')
        throw new Error(`plan10 A 批 · 普通三档预登记阈值触发：${detail}。详见上方原始样本与逐项判定。`)
      }
      expect(failed).toEqual([])
    },
    600_000
  )

  it(
    '测量单会话巨型文件档：整份重写保存耗时与内存（plan10 R1 缺口）',
    async () => {
      const rows: string[] = []
      let fail = false

      for (const scale of GIANT_SCALES) {
        const root = tmpRoot()
        const backend = createFsConversationsBackend(root)
        const id = 'giant'

        // 种子：一次性造到目标大小（文件从零到巨型，同样是整份重写路径）
        const messages = makeGiantMessages(scale.targetBytes)
        await backend.writeMessages(id, messages)
        const filePath = join(root, 'conversations', `${id}.json`)
        const fileBytes = statSync(filePath).size

        // save 采样：模拟「会话再长一点 → 追加一条 → 整份重写保存」——追加+指针回滚后的真实每轮负担
        // 注意必须 await：writeMessages 含 fsyncFile/fsyncDir，这是持久化代价的一部分，不能绕开
        const saveSamples: number[] = []
        for (let k = 0; k < scale.runs; k += 1) {
          messages.push(giantMsg(messages.length + 100000 + k))
          const t0 = performance.now()
          await backend.writeMessages(id, messages)
          saveSamples.push(performance.now() - t0)
        }
        // ⚠️ R1 保留旧统计算法与旧阈值，未纳入本轮 R7 修复（普通三档才切 R7）
        const s = legacyStats(saveSamples)

        // 堆增量：单次保存期间新分配且未及回收的量（stringify 产物 + Buffer 等，gc → await → 不 gc 量）
        // 有 GC 时序噪声，跑 3 次取中位数，量级参考用
        const heapSamples: number[] = []
        for (let k = 0; k < 3; k += 1) {
          global.gc?.()
          const before = process.memoryUsage().heapUsed
          await backend.writeMessages(id, messages)
          heapSamples.push(process.memoryUsage().heapUsed - before)
        }
        heapSamples.sort((a, b) => a - b)
        const heapBytes = heapSamples[1] ?? 0
        const ratio = heapBytes / fileBytes

        // 判定只钉在 10MB 档（估算表的锚点），1MB/5MB 只出曲线不看门
        const isGiant10 = scale.targetBytes >= 10 * 1024 * 1024
        const rowFail =
          isGiant10 && (s.p95 > GIANT_THRESHOLDS.giant10MBSaveP95Ms || ratio > GIANT_THRESHOLDS.giant10MBHeapRatio)
        if (rowFail) fail = true

        rows.push(
          [
            scale.name,
            `文件 ${mb(fileBytes).toFixed(2)}MB（${messages.length} 条）`,
            `save P50 ${s.p50.toFixed(1)}ms / P95 ${s.p95.toFixed(1)}ms`,
            `堆增量 ${(heapBytes / 1024 / 1024).toFixed(1)}MB（约 ${ratio.toFixed(1)} 倍文件）`,
            rowFail ? '⚠️ 超阈值' : 'ok'
          ].join(' | ')
        )
      }

      console.log(
        '\n===== plan10 R1 · 单会话巨型文件档（预登记判定：10MB 档 save P95 < 500ms 且堆增量 < 6 倍文件）=====\n' +
          '⚠️ R1 旧统计口径，未纳入本轮 R7 修复：p50/p95 用 floor(p/100×n) 零基下标，样本数与阈值维持原样。\n' +
          `R1 工作进程环境：node=${process.version} gcEnabled=${String(typeof global.gc === 'function')}`
      )
      for (const r of rows) console.log('· ' + r)
      const verdict = fail
        ? '超阈值 —— 整份重写在巨型档不可接受，plan10 R1 分片追加应尽快立项'
        : '未超阈值 —— 分片追加按「每轮可感知延迟」排期，不构成紧急迁移'
      console.log(`\n===== 巨型档结论：${verdict} =====\n`)
    },
    600_000
  )
})

process.on('exit', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})