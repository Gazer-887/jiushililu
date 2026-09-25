// 记忆的**装配层**（plan19 §0.3 条 5 / §3.3）：数据根 → fs 后端 → repo，跑一次幂等的格式迁移。
// ⚠️ 数据根**由组合根注入**，本文件既不解析路径也不碰 electron：
//    记忆层因此**物理上**没有通路能碰到 `store/settings.ts`（权限档的唯一真相源）——
//    这是"记忆改不了权限"那条架构不变量在代码上的落点，由 `architecture.test.ts` 的守卫乙看守。

import type { ChatMessage } from '@shared/ipc'
import { reviewSeenKey } from '@shared/memory'
import type { MemoryIndex, MemoryStats, PrescreenReport } from '@shared/memory'
import type { TokenUsage } from '@shared/usage'
import { createMemoryRepo, type MemoryRepo, type MemoryRepoOptions } from '../memory/memory-core'
import { createReflectionRunner, type ReflectChat, type ReflectOutput } from '../memory/reflection'
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
}

export interface MemoryStore extends MemoryRepo {
  /** 供批 2 的反思队列与告知标记使用（批 1 只保证它存在且持久） */
  backend: FsMemoryBackend
  /**
   * 开一轮采集（护栏 2，D-043）。组合根在一轮对话前调它，轮末 `drainTurn()` 取走上报载荷 ——
   * 采集状态住在这里而不是组合根，是为了让"忘了采集"最多丢**痕迹**，绝不丢**落盘**。
   */
  beginTurn(): void
  drainTurn(): { written: string[]; rejected: { name: string; reason: string }[] }
  // ── 批 2：反思通路 ──
  /** 入队反思会话（幂等；日上限超了返 false）。⚠️ 不校验会话存在 —— 写队列是投机性操作 */
  enqueueReflection(conversationId: string): boolean
  /** 出队一条反思会话（队列空返 null） */
  dequeueReflection(): string | null
  /**
   * 跑反思。⚠️ **先校验会话存在**（审查 C P1：不重试坏 id，不存在的会话直接跳过 + 出队）。
   * 候选进 candidates/，不进 notes/；冲突的候选带 conflictWith 指向旧记忆 file。
   */
  runReflection(conversationId: string): Promise<void>
  /**
   * plan56 片②：把某条提示标成「看过·留下」。**只消提示，不改条目、不改生效状态**，
   * 也不落 `delete` 事件（存活率因此不动）。正文改动后 `updatedAt` 变了会重新出现。
   */
  dismissReview(name: string): boolean
  /** 一键全部看过，返回消掉的条数（界面前先弹确认，条数由这一格自己数） */
  dismissAllReview(): number
  /** 取记忆统计。事件流读不出来 → 返回 null（界面显示「暂无」） */
  getStats(): MemoryStats | null
  /**
   * 跑一次候选区预筛（plan55 片④-a）：把同义提案归簇、为每簇写一份**合并稿候选**。
   * ⚠️ 只写合并稿，**不删来源** —— 来源要等用户批准合并稿时才收掉（`absorbMergeSources`）。
   * ⚠️ 分组质量无判据可测（plan55 §六）：这里只保证形状可信。
   */
  runPrescreen(): Promise<PrescreenReport>
}


const DEFAULT_REFLECTION_DAILY_LIMIT = 20

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
  opts: MemoryRepoOptions & MemoryStoreReflectionOptions = {}
): MemoryStore {
  const warn = opts.onWarn ?? (() => {})
  const reflLog = opts.onReflectionLog ?? (() => {})
  let collecting: { written: string[]; rejected: { name: string; reason: string }[] } | null = null

  // 每次启动都跑一遍（幂等：已是新格式就立刻返回，代价是一次 existsSync + 一次 JSON.parse）
  migrateMemoryFormat(root, fs, warn)
  const backend = createFsMemoryBackend(root, fs, { onWarn: warn })
  const inner = createMemoryRepo(backend, {
    ...opts,
    onWrite: (info) => {
      if (collecting) {
        if (info.ok) collecting.written.push(info.name)
        else collecting.rejected.push({ name: info.name, reason: info.reason ?? '未说明' })
      }
      opts.onWrite?.(info)
    }
  })

  const reflectionRunner = opts.reflectChat
    ? createReflectionRunner({ chat: opts.reflectChat })
    : null

  /** 局部出队（runReflection 和返回对象的方法都用它） */
  function dequeueOne(): string | null {
    const meta = backend.readMeta()
    const next = meta.reflectionQueue.shift()
    if (next === undefined) return null
    backend.writeMeta(meta)
    return next
  }

  async function runReflection(conversationId: string): Promise<void> {
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
      reflLog('反思已达日上限，本轮跳过（队列项保留）', {
        conversationId,
        count: meta.reflectionCount,
        limit
      })
      return
    }

    // 出队（限额检查已在上方通过，现在正式消耗队列项）
    dequeueOne()

    // 审查 C P1：先校验会话存在 —— 坏 id 不重试，跳过（不卡住队列）
    if (opts.conversationsExists && !opts.conversationsExists(conversationId)) {
      reflLog('反思跳过：会话不存在', { conversationId })
      return
    }
    if (!opts.getConversationForReflect) {
      reflLog('反思跳过：未注入会话读取口', { conversationId })
      return
    }
    const conv = opts.getConversationForReflect(conversationId)
    if (!conv) {
      reflLog('反思跳过：会话正文读不出来', { conversationId })
      return
    }
    if (!reflectionRunner) {
      reflLog('反思跳过：未注入 reflectChat', { conversationId })
      return
    }

    let output: ReflectOutput
    try {
      output = await reflectionRunner.reflect({
        id: conversationId,
        messages: conv.messages,
        bodyBytes: conv.bodyBytes,
        memory: inner
      })
    } catch (err) {
      reflLog('反思执行器抛错', {
        conversationId,
        error: err instanceof Error ? err.message : String(err)
      })
      output = { candidates: [], usage: null }
    }

    // K15：这笔账以前**没有来源** —— 接口声明了、用量牌的「反思 N tokens」也早建好了，
    // 但厂商用量从没被交出来。只在真拿到时才回调：没调用与没报是两种缺省，都不许写成 0。
    if (output.usage) opts.onReflectionUsage?.(conversationId, output.usage)

    for (const c of output.candidates) {
      const file = inner.saveCandidate(c, c.conflictWith)
      if (file && c.conflictWith) {
        const oldEntry = inner.get(c.conflictWith)
        const oldName = oldEntry?.name ?? c.name
        inner.record({
          kind: 'conflict',
          conversationId,
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
      conversationId,
      candidates: output.candidates.length,
      todayCount: afterMeta.reflectionCount
    })
  }

  /** 事件流里读"已看过"集（追加型日志，重放即可；不另开一份状态文件） */
  function seenReviewKeys(): Set<string> {
    const out = new Set<string>()
    for (const e of backend.readEvents().events) {
      if (e.kind === 'review_dismissed') out.add(reviewSeenKey(e.name, e.seenAt))
    }
    return out
  }

  /** 唯一一份"屏幕上那一格有什么"。两个动作与 `list` 必须走它，不能各读各的 */
  function list(): MemoryIndex {
    return inner.list(seenReviewKeys())
  }

  return {
    ...inner,
    backend,
    // plan56 片②：`list` 要拿"已看过"集去筛提示格 ⇒ 必须在 `...inner` 之后覆盖
    list,
    dismissReview: (name: string): boolean => {
      const item = list().needsReview.find((r) => r.name === name)
      if (!item) return false
      return inner.record({
        kind: 'review_dismissed',
        conversationId: null,
        name: item.name,
        seenAt: item.updatedAt
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
            seenAt: it.updatedAt
          })
        )
          n++
      }
      return n
    },
    beginTurn: () => {
      collecting = { written: [], rejected: [] }
    },
    drainTurn: () => {
      const out = collecting ?? { written: [], rejected: [] }
      collecting = null
      return out
    },
    enqueueReflection: (conversationId) => {
      const limit = opts.dailyLimit ?? DEFAULT_REFLECTION_DAILY_LIMIT
      const meta = backend.readMeta()
      const today = todayString()
      if (meta.reflectionDate !== today) {
        meta.reflectionDate = today
        meta.reflectionCount = 0
      }
      // ⚠️ 队列长度判限（不查 reflectionCount —— reflectionCount 在 runReflection 里是执行限额，
      //    在 enqueueReflection 里用会误杀已执行过但队列还满的情况）
      if (meta.reflectionQueue.length >= limit) {
        reflLog('反思入队被拒：队列已达上限', {
          conversationId,
          queueLength: meta.reflectionQueue.length,
          limit
        })
        return false
      }
      if (meta.reflectionQueue.includes(conversationId)) return true
      meta.reflectionQueue.push(conversationId)
      backend.writeMeta(meta)
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
    }
  }
}
