// 主进程事件循环看门狗（plan37 S0）：把「主进程被同步任务占死」变成带时长+阶段归属的证据
// （app.log 平时只记事件，冻结窗口零覆盖）。归属靠阶段变更历史回溯「停滞起点」；
// 检测下限=tick 间隔，故间隔取 250ms（成本：每秒 4 次空回调，可忽略）。
// ⚠️ 本文件不 import electron（架构守卫；单测可直接驱动计时）。
//
// plan49 A+B 埋点：面包屑只挂 ipcMain.handle ⇒ 主进程内部同步任务占死循环时**完全不记账**，
// 且 crumbs 是时刻点、恢复后才补记 → 100% 落在停滞末段（拿它指元凶＝倒果为因）。
// 故新增**同步块区间插桩**：块完成时留起止时刻，告警时按「区间是否与停滞窗口重叠」归属。

import { createLogger } from './log'

const log = createLogger('watchdog')

const HISTORY_MAX = 16
const CRUMBS_MAX = 48

/** 面包屑：IPC/耗时动作的进出记录。停滞告警时随附最近几条 —— 阻塞发生时"最后一条没出"即元凶。
 *  由 index.ts 的 ipcMain.handle 包装器与各处手动 note() 喂数据；本模块保持零 electron 依赖（架构守卫）。 */
let crumbs: { t: number; text: string }[] = []

export function breadcrumb(text: string): void {
  crumbs.push({ t: performance.now(), text })
  if (crumbs.length > CRUMBS_MAX) crumbs = crumbs.slice(-CRUMBS_MAX / 2)
}

function crumbsSince(stallStart: number): string[] {
  return crumbs
    .filter((c) => c.t >= stallStart - 3000) // 多带 3s 前情，只看停滞窗口会丢"进门前那笔"
    .slice(-8)
    .map((c) => `${Math.round(c.t - stallStart)}ms ${c.text}`)
}

// ── 同步块插桩（plan49 A+B）───────────────────────────────────────────

/** 入档下限：低于此值的块不进 bigBlocks。110 个 fs 调用点绝大多数是亚毫秒，
 *  无下限会让每次 finally 都 push 一个对象（GC 压力换不来的诊断价值）。 */
const MIN_BLOCK_MS = 50
/** 慢块告警阈值：超过即**即使正常完成也记一条**（B 档判据，不依赖"未离开"特征） */
const SLOW_BLOCK_MS = 500
/** 同 label 慢块告警节流窗口 —— 防一个循环里的大文件读把 app.log 刷爆 */
const SLOW_REPORT_THROTTLE_MS = 5000
/** 池子容量。满了保新弃旧 ⇒ 理论上会丢掉最早那个横跨者，但两类形态各自不受影响：
 *  "单块占死"本来就只有一个块入档；"多块累积"没有横跨者，丢几个只让 sumMs 偏保守。
 *  告警后清池（见 tick 内），所以容量只需覆盖**单次**停滞。 */
const BIG_BLOCKS_MAX = 64
/** 心跳间隔：5 分钟一条 INFO，成本可忽略，换来"探针活着"的常态证据 */
const HEARTBEAT_MS = 5 * 60 * 1000

type Block = { label: string; startedAt: number; endedAt: number }

/** 够格的已完成块，按结束时刻递增（嵌套时内层先入、外层后入 ⇒ 倒序取到的自然是外层） */
let bigBlocks: Block[] = []
let lastSlowReportAt = new Map<string, number>()
/** 诊断通路标志：为真时**既不递归告警、也不记账**。
 *  两个方向都要防 —— 落盘会调 statSync / readdirSync（log.ts 的轮转），那些调用同样被插桩：
 *  不掐则一次慢轮转能把告警自己的块写进归属池，污染下一次判定。 */
let reporting = false
/** 自启动以来进过 traceSync 的块数。**插桩是否在干活的自检信号**：
 *  停滞告警里 traced=0 ⇒ 插桩压根没命中（别把"没抓到"读成"没有同步任务"）。 */
let tracedBlocks = 0
/** 插桩累计耗时（含未入档的小块）。与 `traced` 合起来才分得开两种"什么都没抓到"：
 *  块多而总耗时小 ⇒ 真凶不在插桩面；块多且总耗时与停滞同量级 ⇒ 是**高频小块**在烧循环。 */
let tracedMs = 0
/** 被池子容量裁掉的块数：不报出来的话，末段的 `coveredMs` 会被当成全貌 */
let droppedBlocks = 0
let hbTimer: NodeJS.Timeout | null = null
let hbLastBlocks = 0
let hbLastMs = 0

/**
 * 观测口：**只给测试用**（线上不读它）。留着是有意的 —— 记账数没有别的出口，
 * 删掉它 `watchdog` 的测试就只能靠日志猜。（plan54 #7 判定：该留并注明）
 */
export function peekTracedBlocks(): number {
  return tracedBlocks
}

/** 诊断动作的唯一入口：记账与告警都不许反噬主流程。
 *  ⚠️ finally 里抛错会**顶掉原始异常**（含 err.code）—— 插桩层一旦这么干，
 *  上层依赖 EACCES / EEXIST / ENOENT 分型的分支会全部走错，且丢掉可恢复性。 */
function diag(fn: () => void): void {
  reporting = true
  try {
    fn()
  } catch {
    // 诊断失败不外溢
  } finally {
    reporting = false
  }
}

/** 同步块插桩。嵌套无需额外栈：外层在内层之后入档，归属倒序自然取到最外层。
 *  ⚠️ 不记"正在跑"的槽 —— 块占死循环时 tick 压根跑不到，等它跑到块已经 finally 了，
 *  那个槽永远读不出东西（plan49 A 档原案的"进了没出"判据在此不可达）。 */
export function traceSync<T>(label: string, fn: () => T): T {
  if (reporting) return fn() // 诊断通路自身不记账
  const at = performance.now()
  tracedBlocks++
  try {
    return fn()
  } finally {
    try {
      noteBlockEnd(label, at, performance.now())
    } catch {
      // 记账失败绝不改变本次调用的返回值与异常
    }
  }
}

/** 异步跨度：只进面包屑，**既不入归属池也不报慢**（await 期间循环是空的，它的区间照样
 *  覆盖停滞起点，算进去就是把旁观者判成凶手；而页面加载常态 >500ms，报出来全是噪音） */
export async function traceSpan<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const at = performance.now()
  breadcrumb(`> ${label}`)
  try {
    const r = await fn()
    breadcrumb(`< ${label} ${Math.round(performance.now() - at)}ms`)
    return r
  } catch (err) {
    breadcrumb(`× ${label} ${Math.round(performance.now() - at)}ms`)
    throw err
  }
}

function noteBlockEnd(label: string, startedAt: number, endedAt: number): void {
  const ms = endedAt - startedAt
  tracedMs += ms
  if (ms >= MIN_BLOCK_MS) {
    bigBlocks.push({ label, startedAt, endedAt })
    if (bigBlocks.length > BIG_BLOCKS_MAX) {
      droppedBlocks += bigBlocks.length - BIG_BLOCKS_MAX / 2
      bigBlocks = bigBlocks.slice(-BIG_BLOCKS_MAX / 2)
    }
  }
  if (ms < SLOW_BLOCK_MS || reporting) return
  const prev = lastSlowReportAt.get(label)
  if (prev !== undefined && endedAt - prev < SLOW_REPORT_THROTTLE_MS) return
  if (lastSlowReportAt.size > 32) lastSlowReportAt = new Map()
  lastSlowReportAt.set(label, endedAt)
  diag(() => log.warn('长任务已完成', { label, ms: Math.round(ms) }))
}

/**
 * 停滞归因。**两条判据都要给**，因为单看一条必然误读：
 * - `culprit`：执行区间横跨停滞起点的块 ⇒ 它就是占死循环的那个（最外层优先）。
 * - `inWindow`：落在停滞窗口内的块数与**去重后**的覆盖时长 ⇒ 覆盖"多块累积占死"这种没有单一横跨者的形态。
 * `culprit` 与 `inWindow` 都空而 `traced` > 0 ⇒ 占死者不在插桩面内，这是"该往哪扩面"的证据，不是"没问题"。
 * 看区间而不是看结束时刻 —— 结束时刻必然落在末段，用它归属就是重犯 crumbs 的倒果为因（§9.1）。
 */
function attributeStall(
  stallStart: number,
  now: number
): {
  culprit: { label: string; ms: number } | null
  inWindow: { n: number; coveredMs: number; top: { label: string; ms: number } } | null
} {
  let culprit: { label: string; ms: number } | null = null
  let top: { label: string; ms: number } | null = null
  let n = 0
  const segs: Array<[number, number]> = []
  for (let i = bigBlocks.length - 1; i >= 0; i--) {
    const b = bigBlocks[i]!
    const dur = b.endedAt - b.startedAt
    if (!culprit && b.startedAt <= stallStart && b.endedAt >= stallStart) {
      culprit = { label: b.label, ms: Math.round(dur) }
    }
    const s = Math.max(b.startedAt, stallStart)
    const e = Math.min(b.endedAt, now)
    if (e > s) {
      n++
      segs.push([s, e])
      if (!top || dur > top.ms) top = { label: b.label, ms: Math.round(dur) }
    }
  }
  // 嵌套块的区间互相包含，直接相加会把外层算两遍 —— 一条诊断日志要是能说出
  // "块累计 480ms > 本次停滞 260ms"，它就整体不可信了。合并区间后再取长度。
  segs.sort((a, b) => a[0] - b[0])
  let coveredMs = 0
  let cursor = Number.NEGATIVE_INFINITY
  for (const [s, e] of segs) {
    const from = Math.max(s, cursor)
    if (e > from) {
      coveredMs += e - from
      cursor = e
    }
  }
  return { culprit, inWindow: n > 0 ? { n, coveredMs: Math.round(coveredMs), top: top! } : null }
}

let phase = 'idle'
// 哨兵条目：历史被截断后兜底为 unknown，宁可说"不知道"也不误归给残存阶段
let history: { phase: string; at: number }[] = [{ phase: 'unknown', at: Number.NEGATIVE_INFINITY }]
let timer: NodeJS.Timeout | null = null
let lastTick = 0
let intervalMs = 250
let thresholdMs = 1000

/**
 * 设置阶段并**返回前值** —— 调用方必须在 finally 里回存前值（setWatchdogPhase(prev)）。
 * 阶段是单槽全局量：并发路径（工具执行 vs 会话保存）硬写 'idle' 会互相抹平，
 * 与 finishClose/FLUSH_TIMEOUT_MS 同类的单槽坑，save/restore 是唯一稳的用法。
 */
export function setWatchdogPhase(next: string): string {
  const prev = phase
  if (next !== phase) {
    phase = next
    history.push({ phase: next, at: performance.now() })
    if (history.length > HISTORY_MAX) history = history.slice(-(HISTORY_MAX - 1))
  }
  return prev
}

/** 回溯「停滞起点」时刻生效的阶段（performance.now 单调，不受系统时钟回跳影响） */
function phaseAt(stallStart: number): string {
  let hit = history[0]!.phase
  for (const h of history) {
    if (h.at <= stallStart) hit = h.phase
    else break
  }
  return hit
}

/**
 * 插桩心跳：让「探针是否在响」成为**常态可观测项**，而不是只能靠停滞来反证。
 * 实测 K1 的起因：0.13.77 真机跑 20.5 分钟停滞 0 条，而 traced/tracedMs 只在停滞告警分支输出
 * ⇒ "0 条"分不清"确实没卡"与"探针没记账"。
 * ⚠️ 心跳**只挂在周期定时器上**：别指望"退出时补一次" —— `stopWatchdog` 在生产代码里
 *    零调用点（真机实测证实：优雅退出后没有第二次心跳），挂在它上面就是死代码。
 *    每条心跳都带 `total` 累计值，所以最终读数本来就有，不需要退出那一次。
 * ⚠️ 心跳自己会经 appendFileSync 落盘，而它在插桩名单里 —— 不掐的话每次心跳都给增量垫一笔，
 * "零记账"信号就被探针自己污染了。`diag()` 的 reporting 闸正好挡住（reporting 期间不记账）。
 */
function heartbeat(): void {
  const delta = tracedBlocks - hbLastBlocks
  const deltaMs = Math.round(tracedMs - hbLastMs)
  hbLastBlocks = tracedBlocks
  hbLastMs = tracedMs
  const msg = '插桩心跳（探针存活证据）'
  if (tracedBlocks === 0) {
    // 应用启动必然走大量同步 fs（store / 技能 / 手册加载）⇒ 自启动零记账只可能是插桩没生效
    diag(() => log.warn(msg, { blocks: 0, note: '自启动以来一次都没记账 ⇒ 插桩可能未生效，"无停滞"读数不可信' }))
  } else {
    diag(() => log.info(msg, { blocks: delta, ms: deltaMs, total: tracedBlocks }))
  }
}

export function startWatchdog(opts?: {
  intervalMs?: number
  thresholdMs?: number
  heartbeatMs?: number
}): void {
  if (timer) return
  intervalMs = opts?.intervalMs ?? 250
  thresholdMs = opts?.thresholdMs ?? 1000
  const hbMs = opts?.heartbeatMs ?? HEARTBEAT_MS
  lastTick = performance.now()
  history = [{ phase: 'unknown', at: Number.NEGATIVE_INFINITY }, { phase, at: lastTick }]
  // 插桩状态不跨启停存活（与 D-119 ②「缓存不许跨重挂载存活」同源）
  bigBlocks = []
  crumbs = []
  lastSlowReportAt = new Map()
  tracedBlocks = 0
  tracedMs = 0
  droppedBlocks = 0
  hbLastBlocks = 0
  hbLastMs = 0
  timer = setInterval(() => {
    const now = performance.now()
    const stall = now - lastTick - intervalMs
    lastTick = now
    if (stall > thresholdMs) {
      const stallStart = now - stall
      const attr = attributeStall(stallStart, now)
      diag(() => {
        log.warn('事件循环停滞（主进程被同步任务占死）', {
          stallMs: Math.round(stall),
          phase: phaseAt(stallStart),
          block: attr.culprit,
          inWindow: attr.inWindow,
          traced: tracedBlocks,
          tracedMs: Math.round(tracedMs),
          dropped: droppedBlocks,
          crumbs: crumbsSince(stallStart)
        })
      })
      // 每次停滞独立归因：告警后清池，既防上一轮的块混进下一次判定，
      // 也防告警自己落盘时碰的 statSync / readdirSync 被记成"证据"
      bigBlocks = []
      droppedBlocks = 0
    }
  }, intervalMs)
  // 看门狗不许成为进程不退出理由
  timer.unref?.()
  if (hbMs > 0 && !hbTimer) {
    hbTimer = setInterval(heartbeat, hbMs)
    hbTimer.unref?.()
  }
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = null
  }
}
