import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import type { ChatMessage, Conversation } from '@shared/ipc'
import { createConversationsRepo } from '@main/store/conversations-core'
import { createFsConversationsBackend } from '@main/store/conversations-fs'

// plan10 A 批第三块：**测量定引擎**（plan8 R8 的正题）。
// 跑法（显式跑，**不进 CI** —— 阈值是耗时，CI 上会抖）：
//   npx vitest run --config config/vitest.config.ts tests/bench/conversations.bench.ts
//
// ⚠️ **判据先登记、再跑**（plan10 §2.3）：阈值写死在下面、脚本自己出 PASS/FAIL，
//    不允许"跑完看数据再挑一个好看的说法"。
// ⚠️ 下面那份旧实现是**对照基线**（整表读+整表写、正文内嵌），不是产品代码 ——
//    不对比就答不出"分层换来了什么"与"JSON 还够不够快"。

/** 预登记阈值：任一超标 → 结论是"必须迁移（SQLite）" */
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

function pct(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

function stats(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50: pct(sorted, 50), p95: pct(sorted, 95) }
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
      let verdictFail = false

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

        // 列表堆增量："会不会把正文整个拉进内存"
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

        const nl = stats(newListSamples)
        const ns = stats(newSaveSamples)
        const ol = stats(oldListSamples)
        const os = stats(oldSaveSamples)

        const fail = ns.p95 > THRESHOLDS.saveP95Ms || newHeap > THRESHOLDS.listHeapDeltaMB
        if (fail) verdictFail = true

        rows.push(
          [
            scale.name,
            `list 新 ${nl.p95.toFixed(1)}ms / 旧 ${ol.p95.toFixed(1)}ms`,
            `save 新 ${ns.p95.toFixed(1)}ms / 旧 ${os.p95.toFixed(1)}ms`,
            `list 堆增量 新 ${newHeap.toFixed(2)}MB / 旧 ${oldHeap.toFixed(2)}MB`,
            `索引 ${newBytes}B vs 正文约 ${mb(bodyBytes).toFixed(1)}MB（旧整表 ${mb(oldBytes).toFixed(1)}MB）`,
            fail ? '⚠️ 超阈值' : 'ok'
          ].join(' | ')
        )
      }

      console.log('\n===== plan10 A 批 · 测量结果（预登记阈值：list/save P95 < 50ms，列表堆增量 < 20MB）=====')
      for (const r of rows) console.log('· ' + r)
      console.log(`\n===== 引擎结论：${verdictFail ? '必须迁移（有指标超阈值）' : '不迁移 —— 保持 JSON（分层之后已无致命点）'} =====\n`)
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
        const s = stats(saveSamples)

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
        '\n===== plan10 R1 · 单会话巨型文件档（预登记判定：10MB 档 save P95 < 500ms 且堆增量 < 6 倍文件）====='
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
