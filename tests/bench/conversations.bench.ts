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
})

process.on('exit', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})
