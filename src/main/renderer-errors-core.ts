/**
 * 渲染层错误通路的**纯逻辑**部分（K58）。
 *
 * ⚠️ **这个文件存在的原因是一条被违反过的红线**：`renderer-errors.ts` 需要 `app` / `ipcMain` /
 * `WebContents`，而 CI 的 `quality` job **跳过 electron 二进制下载**（它只要 typecheck / lint /
 * 单测）⇒ 单测里 `import from '@main/renderer-errors'` 在 CI 上会直接
 * `Electron failed to install correctly`，而**本机有二进制所以全绿**。
 * —— 这是本项目「本地全绿 ≠ 通过」的第六次兑现，且这次是我自己新引入的依赖边。
 *
 * ⇒ 形状照本项目既有先例（`main/log.ts` 只 import `node:fs` / `node:path`、
 * `main/watchdog.ts` 被三个单测 import 且同样不碰 electron）：**可单测的模块不 import electron**，
 * 纯逻辑放这里，electron 那半留在 `renderer-errors.ts` 并从这儿取。
 */

/** 收哪两档：**warning 与 error**。info / verbose / debug 不进。 */
export type ConsoleLevel = unknown

/**
 * `isRecordedConsoleLevel` 的判定本体。
 *
 * ⚠️ **两种 level 形态都要认**（查证 Electron 35.0 breaking-changes）：
 * - Electron ≤34 传**数字**：0 verbose / 1 info / 2 warning / 3 error；
 * - Electron **≥35 改传 Event 对象**，`level` 变成**字符串** `'info' / 'warning' / 'error' / 'debug'`。
 * 只认数字的话，升级 Electron 那天这条通路会**静默全灭**（字符串与数字比恒不等，
 * 恒真 → 全部 return），而症状与"没做"一模一样。
 */
export function isRecordedConsoleLevel(level: ConsoleLevel): boolean {
  if (typeof level === 'number') return level === 2 || level === 3
  if (typeof level === 'string') return level === 'warning' || level === 'error'
  return false
}

/** 该 level 是不是 error 档（决定日志文案用 error 还是 warn） */
export function isErrorLevel(level: ConsoleLevel): boolean {
  return level === 3 || level === 'error'
}

/** 同一条消息在这个窗口期内只记一次；过了就重新记（现场会变） */
export const THROTTLE_MS = 60_000
/** 单条文本上限：堆栈和 message 都可能很长，全写会挤掉别的现场 */
export const MAX_TEXT = 2000
/**
 * 去重表的容量上限。**超过就整表清空**（照 `watchdog.ts · noteBlockEnd` 的 `size > 32` 写法）。
 *
 * ⚠️ 为什么必须有上限：键由**消息内容**构成，而只出现一次的消息**永远等不到第二次**去碰它
 * ⇒ 每次都是新键、60 秒节流对高基数 message **一次都不生效**（"AbortError: request 8f3a… cancelled"
 * 这类带 id 的、浏览器页面里嵌着 URL 与轮转 token 的，都是高基数）。
 * 不清扫 ⇒ 主进程内存单调上涨，**与磁盘轮转无关、不会自己停**（09-28 独立审查抓出）。
 */
export const MAX_KEYS = 512

export interface ThrottleState {
  lastAt: Map<string, number>
}

export function createThrottleState(): ThrottleState {
  return { lastAt: new Map() }
}

/**
 * 去重节流（**纯逻辑，时钟由外面注入**）。
 *
 * 为什么要把时钟做成参数：直接用 `Date.now()` 的话，"60 秒内不重复"这条判据**测不了** ——
 * 只能真等一分钟，而真等一分钟的测试等于没有测试。同本仓"冻结时钟直测落盘函数"是同一条纪律。
 *
 * 被节流时返回 `{ record: false }` 且**调用方不该写任何东西**（每次都写一条"已节流"就是另一种
 * 刷屏）；累计次数在**下一条真记录**上以 `repeat` 带出 —— 那才是读者要的信息
 *（"这条每分钟炸 60 回"），且代价是每窗口期一条。
 */
export function throttle(
  state: ThrottleState,
  key: string,
  now: number,
  windowMs: number = THROTTLE_MS
): { record: true; sinceMs: number; repeat: number } | { record: false } {
  const counterKey = `${key}#n`
  const prev = state.lastAt.get(key)
  if (prev !== undefined && now - prev < windowMs) {
    const n = (state.lastAt.get(counterKey) ?? 0) + 1
    state.lastAt.set(counterKey, n)
    return { record: false }
  }
  // 重新计时 ⇒ 把**上一窗口期累计的重复次数**交回给调用方
  const repeat = state.lastAt.get(counterKey) ?? 0
  state.lastAt.set(key, now)
  state.lastAt.delete(counterKey)
  // ★ 容量上限：整表清空而不是逐个淘汰（照 `watchdog.ts · noteBlockEnd`）。
  //   逐个淘汰要维护 LRU 序，而这张表的键是"每条只出现一次就再也不碰"的高基数 ⇒
  //   任何淘汰策略的差别只在多花多少 CPU，清空最省。
  if (state.lastAt.size > MAX_KEYS) state.lastAt.clear()
  return { record: true, sinceMs: prev === undefined ? -1 : now - prev, repeat }
}

/** 截断 + 单行化：日志是一行一条记录，多行会把可读性毁掉 */
export function oneLine(text: string, max: number = MAX_TEXT): string {
  const flat = text.replace(/\r?\n/g, ' \\n ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…(已截断，原长 ${flat.length})` : flat
}

/** 载荷**逐字段自己定型**（不整体 stringify）——它来自一个刚抛了异常的上下文，可能是半个对象 */
export interface SanitizedReport {
  kind: 'error' | 'unhandledrejection'
  message: string
  stack: string
  source: string
  line: number
  column: number
}

export function sanitizeReport(raw: unknown): SanitizedReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error'
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // 拒绝原因是对象（`Promise.reject({code:1})`）时给一句可读摘要，别直接 "[object Object]"
  let message = str(r.message).trim()
  if (!message) message = '(无 message)'
  return {
    kind,
    message: oneLine(message),
    stack: oneLine(str(r.stack)),
    source: oneLine(str(r.source), 300),
    line: num(r.line),
    column: num(r.column)
  }
}
