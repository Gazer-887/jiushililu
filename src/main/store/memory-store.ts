// 记忆的**装配层**（plan19 §0.3 条 5 / §3.3）：数据根 → fs 后端 → repo，跑一次幂等的格式迁移。
// ⚠️ 数据根**由组合根注入**，本文件既不解析路径也不 import electron / settings。
//    守卫乙检查 MEMORY_ROOTS 中的纯逻辑入口（memory-core / inject / reflection）；
//    本装配层不在入口清单内，不宣称其 import 图已由该守卫验证。

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/ipc'
import { reviewSeenKey } from '@shared/memory'
import type { MemoryIndex, MemorySearchResult, MemoryStats, PrescreenReport } from '@shared/memory'
import type { TokenUsage } from '@shared/usage'
import { createFtsIndex, type FtsIndex } from '../memory/fts'
import { createMemoryRepo, type MemoryRepo, type MemoryRepoOptions } from '../memory/memory-core'
import { createReflectionRunner, type ReflectChat, type ReflectOutput } from '../memory/reflection'
import { queueWaitSample } from '../memory/calibration'
import {
  PRESCREEN_SYSTEM_PROMPT,
  buildPrescreenPrompt,
  composeMergedBody,
  parsePrescreenResult
} from '../memory/prescreen'
import { nodeFsAdapter, type FsAdapter } from './conversations-fs'
import {
  createFsMemoryBackend,
  migrateMemoryFormat,
  type FsMemoryBackend
} from './memory-fs'

/** 反思用的会话数据（装配层从 conversations 取出后注入） */
export interface ReflectConversation {
  messages: ChatMessage[]
  bodyBytes: number
}

/** 反思依赖注入（装配层负责取数据 + 组装 system prompt） */
export interface MemoryStoreReflectionOptions {
  /** 校验会话 id 存在（审查 C P1：不重试坏 id）。不传 = 跳过校验 */
  conversationsExists?: (id: string) => boolean
  /** 取会话正文（含 bodyBytes）。不传 = 反思无法跑 */
  getConversationForReflect?: (id: string) => ReflectConversation | null
  /** 反思 chat 接口（组装好的 messages 进来，反思输出出去） */
  reflectChat?: ReflectChat
  /** 反思用量记录回调。装配层把它接到 UsageRecord（kind='reflection'） */
  onReflectionUsage?: (conversationId: string, usage: TokenUsage) => void
  /** 反思日志（不传 = 静默） */
  onReflectionLog?: (message: string, extra?: Record<string, unknown>) => void
  /** 反思日上限（缺省 20，跨日重置） */
  dailyLimit?: number
  /**
   * D-200②A：反思队列容量（缺省 100，独立于 dailyLimit）。
   * 20 是日执行上限语义，兼作容量会让「超限排队不丢弃」名存实亡（队满即拒）。
   */
  queueCapacity?: number
}

/** FTS 全文索引（plan63 片 2）的装配选项 */
export interface MemoryStoreFtsOptions {
  /**
   * 索引 DB 路径；缺省 `<root>/fts.db`。显式 `null` = 关闭全文索引
   * （内存 fs 的单测传 null，防测试真落 SQLite 文件）。初始化失败标为不可用，正文能力保留。
   */
  ftsPath?: string | null
}

export interface MemoryStore extends MemoryRepo {
  /** 供批 2 的反思队列与告知标记使用（批 1 只保证它存在且持久） */
  backend: FsMemoryBackend
  /**
   * 开一轮采集（护栏 2，D-043）。组合根在一轮对话前调它，轮末 `drainTurn()` 取走上报载荷 ——
   * 采集状态住在这里而不是组合根，是为了让"忘了采集"最多丢**痕迹**，绝不丢**落盘**。
   * `index` = 本轮实际注入投影（组合根刚 list() 过，顺带采样截断比例，避免二次全量读）；
   * 不传 = 自取当前投影（测试与隔离路径）。
   */
  beginTurn(index?: MemoryIndex): void
  drainTurn(): { written: string[]; rejected: { name: string; reason: string }[] }
  // ── 批 2：反思通路 ──
  /** 队列未满时重复入队幂等，满容量返 false；日执行额度不限制入队，不校验会话存在。 */
  enqueueReflection(conversationId: string): boolean
  /** 出队一条反思会话（队列空返 null） */
  dequeueReflection(): string | null
  /**
   * 有参精确出队，无参取队首；额度满/无目标返 false 且不出队，消费一项（含坏id）返 true。
   * ⚠️ 调用方不许预出队，否则会跳项或在额度满时吞队列；内部串行防并发透支。
   * 候选只进 candidates/，冲突指向旧记忆；坏id留痕后跳过，不重试。
   */
  runReflection(conversationId?: string): Promise<boolean>
  /**
   * plan56 片②：把某条提示标成「看过·留下」。**只消提示，不改条目、不改生效状态**，
   * 也不落 `delete` 事件（存活率因此不动）。正文改动后 `updatedAt` 变了会重新出现。
   */
  /** 消掉一条提示。⚠️ 入参是**条目的 file**，不是 name（同名两条会消错） */
  dismissReview(file: string): boolean
  /** 一键全部看过，返回消掉的条数（界面前先弹确认，条数由这一格自己数） */
  dismissAllReview(): number
  /** 取记忆统计。事件流读不出来 → 返回 null（界面显示「暂无」） */
  getStats(): MemoryStats | null
  /**
   * 全文检索（plan63 片 3 · D-154/D-156）：BM25 排序的生效条目召回。
   * 显式区分正常零命中、关闭与故障；只有正常结果可携带相关条目。
   */
  searchMemory(query: string, limit?: number): MemorySearchResult
  /**
   * 跑一次候选区预筛（plan55 片④-a）：把同义提案归簇、为每簇写一份**合并稿候选**。
   * ⚠️ 只写合并稿，**不删来源** —— 来源要等用户批准合并稿时才收掉（`absorbMergeSources`）。
   * ⚠️ 分组质量无判据可测（plan55 §六）：这里只保证形状可信。
   */
  runPrescreen(): Promise<PrescreenReport>
}


const DEFAULT_REFLECTION_DAILY_LIMIT = 20
/** D-200②A：队列容量独立于日执行上限（20 兼作容量致队满即拒、判据名存实亡） */
const DEFAULT_REFLECTION_QUEUE_CAPACITY = 100

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 合并稿的落名（plan55 片④-a）。
 * ⚠️ 必须避让现有候选：模型给的 name 常常就是它某条来源的名字（"把这三条并成 verbatim-raw-output"），
 * 而 `saveCandidateFile` 的同名保护（片③ 刚立的）会直接拒掉 —— 不避让的话，合并稿一条都写不进去，
 * 且失败原因对用户是一句看不懂的"已存在同名提案"。
 * ⚠️ 集合要**随每份写成的稿子增长**（审查 R-B4）：模型给两个簇起同一个名字时，
 *    第二份若在一份只包含"原有候选"的集合上判重，就会撞在闸上被静默拒掉。
 */
export function uniqueMergedName(base: string, names: Set<string>): string {
  if (!names.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-merged-${i}`
    if (!names.has(candidate)) return candidate
  }
  return `${base}-merged`
}

export function createMemoryStore(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: MemoryRepoOptions & MemoryStoreReflectionOptions & MemoryStoreFtsOptions = {}
): MemoryStore {
  const warn = opts.onWarn ?? (() => {})
  const reflLog = opts.onReflectionLog ?? (() => {})
  let collecting: { written: string[]; rejected: { name: string; reason: string }[] } | null = null

  // 每次启动都跑一遍（幂等：已是新格式就立刻返回，代价是一次 existsSync + 一次 JSON.parse）
  migrateMemoryFormat(root, fs, warn)
  const backend = createFsMemoryBackend(root, fs, { onWarn: warn })

  // FTS是衍生缓存；资格只由core完整生效快照决定，不再单独解析notes或复制守卫。
  const ftsPath = opts.ftsPath === undefined ? join(root, 'fts.db') : opts.ftsPath
  let fts: FtsIndex | null = null
  let ftsStatus: MemorySearchResult['status'] = ftsPath === null ? 'disabled' : 'ready'
  let indexedSignature: string | null = null

  function disableIndex(stage: string, error: unknown): void {
    ftsStatus = 'unavailable'
    try {
      fts?.close()
    } catch {
      // 关闭缓存失败不能影响已经完成的正文操作。
    }
    fts = null
    try {
      const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null
      const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(rawCode) ? rawCode : 'UNKNOWN'
      warn('记忆全文索引不可用，正文功能保留；关闭应用后重建索引并重启可恢复', { stage, code })
    } catch {
      // 告警接收方失败也不能把成功落盘伪装成保存失败。
    }
  }

  function syncIndex(): void {
    if (!fts) return
    try {
      const entries = inner.listActiveEntries().map(({ file, name, class: cls, body }) => ({
        file, name, class: cls, body
      }))
      const signature = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
      // 签名限制重建频率；行数检查同时修复运行中丢失的专用派生表/缓存文件。
      if (signature !== indexedSignature || fts.count() !== entries.length) {
        fts.replace(entries)
        indexedSignature = signature
      }
    } catch (error) {
      disableIndex('sync', error)
    }
  }

  // 正文操作先完成，只有缓存同步进入隔离异常分支。恢复后直接回填，不依赖闭包调用装饰器。
  const ftsBackend: FsMemoryBackend = {
    ...backend,
    write(file, text) {
      backend.write(file, text)
      syncIndex()
    },
    remove(file) {
      const ok = backend.remove(file)
      if (ok) syncIndex()
      return ok
    },
    archive(file) {
      const target = backend.archive(file)
      if (target !== null) syncIndex()
      return target
    },
    restoreFrom(file) {
      const target = backend.restoreFrom(file)
      if (target !== null) syncIndex()
      return target
    }
  }

  const inner = createMemoryRepo(ftsBackend, {
    ...opts,
    onWrite: (info) => {
      if (collecting) {
        if (info.ok) collecting.written.push(info.name)
        else collecting.rejected.push({ name: info.name, reason: info.reason ?? '未说明' })
      }
      opts.onWrite?.(info)
    }
  })

  if (ftsPath !== null) {
    try {
      fts = createFtsIndex(ftsPath)
      syncIndex()
    } catch (error) {
      disableIndex('init', error)
    }
  }

  const reflectionRunner = opts.reflectChat
    ? createReflectionRunner({ chat: opts.reflectChat })
    : null

  function recordQueue(action: 'enqueue' | 'dequeue' | 'sample' | 'rejected', conversationId: string | null): void {
    const queue = backend.readMeta().reflectionQueue
    const now = opts.now?.() ?? new Date()
    const ages = queueWaitSample(queue, backend.readEvents().events, now,
      action === 'enqueue' && conversationId !== null ? conversationId : undefined)
    inner.record({ kind: 'reflection_queue', conversationId, action, depth: queue.length, ...ages })
  }

  /** 局部出队（runReflection 和返回对象的方法都用它） */
  function dequeueOne(): string | null {
    const meta = backend.readMeta()
    const next = meta.reflectionQueue.shift()
    if (next === undefined) return null
    backend.writeMeta(meta)
    recordQueue('dequeue', next)
    return next
  }

  /**
   * 按调用顺序串行，catch保持后续任务可执行；本次错误仍从返回的run向调用方抛出。
   */
  let reflectionChain: Promise<unknown> = Promise.resolve()

  /** 有参 = 精确出队；无参 = 队首补跑。true = 消费了一项；false = 未消费（队列不动）。 */
  async function runReflection(conversationId?: string): Promise<boolean> {
    const run = reflectionChain.then(() => runReflectionOnce(conversationId))
    reflectionChain = run.catch(() => {})
    return run
  }

  async function runReflectionOnce(conversationId?: string): Promise<boolean> {
    // ⚠️ 限额检查在出队之前 —— 超限时提前返回，不丢失队列项（队列保持不动）
    const meta = backend.readMeta()
    const today = todayString()
    if (meta.reflectionDate !== today) {
      meta.reflectionDate = today
      meta.reflectionCount = 0
      // ⚠️ 重置后立即落盘（meta 是局部对象，不写回去下次读又回到旧值）
      backend.writeMeta(meta)
    }
    const limit = opts.dailyLimit ?? DEFAULT_REFLECTION_DAILY_LIMIT
    if (meta.reflectionCount >= limit) {
      recordQueue('sample', null)
      reflLog('反思已达日上限，本轮跳过（队列项保留）', {
        conversationId: conversationId ?? meta.reflectionQueue[0] ?? null,
        count: meta.reflectionCount,
        limit
      })
      return false
    }

    // 出队（D-200②A 精确出队）：有参取指定 id，无参取队首；取不到 = 已被并发消费，不动队列
    const target = conversationId ?? meta.reflectionQueue[0]
    if (target === undefined) {
      reflLog('反思跳过：队列为空', {})
      return false
    }
    const idx = meta.reflectionQueue.indexOf(target)
    if (idx < 0) {
      reflLog('反思跳过：指定会话不在队列（可能已被消费）', { conversationId: target })
      return false
    }
    meta.reflectionQueue.splice(idx, 1)
    backend.writeMeta(meta)
    recordQueue('dequeue', target)

    // 审查 C P1：先校验会话存在 —— 坏 id 不重试，跳过（不卡住队列）
    if (opts.conversationsExists && !opts.conversationsExists(target)) {
      reflLog('反思跳过：会话不存在', { conversationId: target })
      return true
    }
    if (!opts.getConversationForReflect) {
      reflLog('反思跳过：未注入会话读取口', { conversationId: target })
      return true
    }
    const conv = opts.getConversationForReflect(target)
    if (!conv) {
      reflLog('反思跳过：会话正文读不出来', { conversationId: target })
      return true
    }
    if (!reflectionRunner) {
      reflLog('反思跳过：未注入 reflectChat', { conversationId: target })
      return true
    }

    let output: ReflectOutput
    let failed = false
    try {
      output = await reflectionRunner.reflect({
        id: target,
        messages: conv.messages,
        bodyBytes: conv.bodyBytes,
        memory: inner
      })
    } catch (err) {
      failed = true
      reflLog('反思执行器抛错', {
        conversationId: target,
        error: err instanceof Error ? err.message : String(err)
      })
      output = { candidates: [], usage: null }
    }
    inner.record({ kind: 'reflection_sample', conversationId: target,
      outcome: output.skipped ? 'skipped' : failed ? 'failed' : 'completed', candidates: output.candidates.length })

    // K15：这笔账以前**没有来源** —— 接口声明了、用量牌的「反思 N tokens」也早建好了，
    // 但厂商用量从没被交出来。只在真拿到时才回调：没调用与没报是两种缺省，都不许写成 0。
    if (output.usage) opts.onReflectionUsage?.(target, output.usage)

    for (const c of output.candidates) {
      const file = inner.saveCandidate(c, c.conflictWith)
      if (file && c.conflictWith) {
        const oldEntry = inner.get(c.conflictWith)
        const oldName = oldEntry?.name ?? c.name
        inner.record({
          kind: 'conflict',
          conversationId: target,
          name: c.name,
          oldName
        })
      }
    }

    // 计数：⚠️ 即使反思没出候选也要计数 —— 一次失败的反思也是一次额度
    // ⚠️ 重新读 meta（runReflection 是异步的，期间可能被其他调用写过）
    const afterMeta = backend.readMeta()
    afterMeta.reflectionCount += 1
    backend.writeMeta(afterMeta)

    reflLog('反思完成', {
      conversationId: target,
      candidates: output.candidates.length,
      todayCount: afterMeta.reflectionCount
    })
    return true
  }

  /** 事件流里读"已看过"集（追加型日志，重放即可；不另开一份状态文件） */
  function seenReviewKeys(): Set<string> {
    const out = new Set<string>()
    for (const e of backend.readEvents().events) {
      if (e.kind === 'review_dismissed') out.add(reviewSeenKey(e.name, e.stamp))
    }
    return out
  }

  /** 唯一一份"屏幕上那一格有什么"。两个动作与 `list` 必须走它，不能各读各的 */
  function list(): MemoryIndex {
    return inner.list(seenReviewKeys())
  }

  return {
    ...inner,
    backend: ftsBackend,
    // plan56 片②：`list` 要拿"已看过"集去筛提示格 ⇒ 必须在 `...inner` 之后覆盖
    list,
    // 入口按 **file** 定位（与全库"读写删一律按 file"同口径）：同名两条提示时，
     // 按 name 找会消掉用户没点的那一条。事件里仍只记 name + 内容指纹（路径含用户名，不进事件流）。
    dismissReview: (file: string): boolean => {
      const item = list().needsReview.find((r) => r.file === file)
      if (!item) return false
      return inner.record({
        kind: 'review_dismissed',
        conversationId: null,
        name: item.name,
        stamp: item.stamp
      })
    },
    // ⚠️ 取的是**筛过之后**的那一格：拿未筛的全量做批量，界面上写着 N 条、实际记了 M 笔，
    //    而且已看过的那几条会被反复追加事件（"显示 3 条移走 5 条"同族）。
    dismissAllReview: (): number => {
      let n = 0
      for (const it of list().needsReview) {
        if (
          inner.record({
            kind: 'review_dismissed',
            conversationId: null,
            name: it.name,
            stamp: it.stamp
          })
        )
          n++
      }
      return n
    },
    beginTurn: (index) => {
      collecting = { written: [], rejected: [] }
      const sample = index ?? list()
      inner.record({ kind: 'injection_sample', conversationId: opts.conversationId?.() ?? null,
        total: sample.total, omitted: sample.omitted })
    },
    drainTurn: () => {
      const out = collecting ?? { written: [], rejected: [] }
      collecting = null
      return out
    },
    enqueueReflection: (conversationId) => {
      const capacity = opts.queueCapacity ?? DEFAULT_REFLECTION_QUEUE_CAPACITY
      const meta = backend.readMeta()
      const today = todayString()
      if (meta.reflectionDate !== today) {
        meta.reflectionDate = today
        meta.reflectionCount = 0
      }
      // ⚠️ 队列长度判限（不查 reflectionCount —— reflectionCount 在 runReflection 里是执行限额，
      //    在 enqueueReflection 里用会误杀已执行过但队列还满的情况）
      // ⚠️ D-200②A：判的是**容量**（独立于 dailyLimit，缺省 100）—— 20 兼作容量时
      //    「超限排队不丢弃」名存实亡（第 21 条被拒之即丢）
      if (meta.reflectionQueue.length >= capacity) {
        // ⚠️ 满也落盘：上方跨日重置是局部对象的修改，不写回就把旧值留给下次读
        backend.writeMeta(meta)
        recordQueue('rejected', conversationId)
        reflLog('反思入队被拒：队列已达上限', {
          conversationId,
          queueLength: meta.reflectionQueue.length,
          capacity
        })
        return false
      }
      if (meta.reflectionQueue.includes(conversationId)) {
        recordQueue('sample', null)
        return true
      }
      meta.reflectionQueue.push(conversationId)
      backend.writeMeta(meta)
      recordQueue('enqueue', conversationId)
      return true
    },
    dequeueReflection: () => dequeueOne(),
    runReflection,
    /**
     * plan55 片④-a：候选区预筛。模型通道**复用反思那一条**（`reflectChat`，
     * 它内部已按「反思模型 → 跟随主对话」解析）—— 不新开设置键：
     * 加了没人读的开关比不加更坏（`token-tier.ts` 那条自陈），而用户要的是"可自选或跟随主对话"，
     * 反思那一格已经给了这个能力。代价：两类任务共用一个模型选择，写进 plan55 备查。
     */
    runPrescreen: async (): Promise<PrescreenReport> => {
      const empty: PrescreenReport = {
        ok: false,
        merged: 0,
        clusters: 0,
        uncovered: 0,
        rejected: [],
        usage: null
      }
      if (!opts.reflectChat) return { ...empty, reason: '未注入模型通道，无法预筛' }
      const cands = inner.list().candidates
      if (cands.length === 0) return { ...empty, reason: '候选区是空的' }

      let content = ''
      let usage: TokenUsage | null = null
      try {
        const res = await opts.reflectChat([
          { role: 'system', content: PRESCREEN_SYSTEM_PROMPT },
          { role: 'user', content: buildPrescreenPrompt(cands) }
        ])
        content = res.content
        usage = res.usage ?? null
      } catch (err) {
        reflLog('预筛调用失败', { error: err instanceof Error ? err.message : String(err) })
        return { ...empty, reason: '预筛调用失败（原因见日志）' }
      }
      if (content.trim().length === 0) return { ...empty, usage, reason: '模型没给出内容' }

      const byFile = new Map(cands.map((c) => [c.file, c]))
      const parsed = parsePrescreenResult(content, cands)
      // 落盘失败也进这一份清单（审查 R-A2）：模型那关过了不等于用户看得见 ——
      // 只回"写了 0 份合并稿"，用户既不知道是哪一份、也不知道为什么。
      const rejected = [...parsed.rejected]
      // 名字集合随每份写成的稿子增长（R-B4：两簇同名时第二份要避让，不是被闸掉）
      const usedNames = new Set(cands.map((c) => c.name))
      let merged = 0
      for (const cluster of parsed.clusters) {
        // 单条簇不写合并稿 —— 它没有被归并，再抄一份只会让队列更长
        if (cluster.sources.length < 2) continue
        const name = uniqueMergedName(cluster.name, usedNames)
        const r = inner.saveCandidateDetailed({
          name,
          description: cluster.description,
          class: cluster.class,
          body: composeMergedBody(cluster, byFile),
          origin: 'model',
          mergeSources: cluster.sources
        })
        if (r.file !== '') {
          merged += 1
          usedNames.add(name)
        } else {
          rejected.push({ name, reason: r.reason ?? '合并稿未能落进候选区' })
        }
      }
      return {
        ok: true,
        merged,
        clusters: parsed.clusters.length,
        uncovered: parsed.uncovered.length,
        rejected,
        usage
      }
    },
    getStats: () => {
      const { events } = backend.readEvents()
      if (events.length === 0) return null
      return inner.computeStats(events)
    },
    searchMemory: (query, limit): MemorySearchResult => {
      syncIndex()
      if (!fts) return { status: ftsStatus === 'disabled' ? 'disabled' : 'unavailable', hits: [] }
      try {
        return { status: 'ready', hits: fts.search(query, limit) }
      } catch (error) {
        disableIndex('search', error)
        return { status: 'unavailable', hits: [] }
      }
    }
  }
}
