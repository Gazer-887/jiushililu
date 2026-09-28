/**
 * 渲染进程错误的可排查性（K58 / plan8 R18 的"没修的那一半"）。
 *
 * **为什么需要它**：2026-09-27 用户实机报"点复制没反应"，排查全靠"猜 → 造探针 → 三臂对照"。
 * 实测 `app.log` 里 `clipboard` / `NotAllowed` / `TypeError` / `Uncaught` **全部零命中** ——
 * 而零命中是**没有探针**，不是**没报错**。⇒ 那个 bug 从"报了障"到"找到根因"花了三轮。
 * 有了这条通路，同类报障的第一现场就会有 `NotAllowedError: Document is not focused`。
 *
 * **挂载方式**：`app.on('web-contents-created')` 一次罩住**所有**窗口（含设置窗、含将来新开的），
 * 而不是去每个 `createWindow` 里加一行 —— "多接一处必然漏"是本项目反复吃过的亏（D-134/D-136）。
 *
 * **收什么**（每一条都是取舍，不是默认全收）：
 * - `console.error` / `console.warn` ⇒ 进日志；**`console.log` / `debug` / `info` 不进** ——
 *   用户正文最可能出现在 `log` 里（那是应用自己的输出通道），且量最大（K48 的 828 条重复 WARN 教训）。
 * - 渲染层 `window.onerror` / `unhandledrejection` ⇒ 进日志。
 * - **只收自家窗口**（`getType() === 'window'`）：内置浏览器装的是**任意外部网址**，
 *   远程页面的 `console.error` 会把 URL、`?token=…` 写进用户正在教开发者发出去的文件里。
 * - 全部经 `log.ts` 的 `scrub()` 脱敏（Key / Bearer / token 形状）。
 * - 全部经 `throttle` 去重：同一条在窗口期内只记一次；**累计次数在下一条真记录上以
 *   `repeat` 带出**（每次都写一条"已节流"是另一种刷屏），去重表**有容量上限**。
 *   ⚠️ 没有节流与上限的话，一个渲染循环异常能把 `app.log` 刷爆并触发轮转，
 *   **把真正的现场挤掉** —— 记录手段本身成了故障放大器。
 *
 * **不做什么**：不弹窗。渲染层错误大多可恢复（一次交互失败而已），弹窗会骚扰 ——
 * `crash-guard` 对 `unhandledRejection` 也是这个口径（那里写明"常为可恢复的操作失败"）。
 */
import { app, ipcMain, type WebContents } from 'electron'
import { createLogger } from './log'
import { getWindow } from './window-registry'
import { IPC, type RendererErrorReport } from '@shared/ipc'

const log = createLogger('renderer-error')

/** 幂等标记：**模块级状态**，不用 `app` 单例上猴补属性（同 `watchdog.ts · startWatchdog` / `sync-trace.ts` 的做法） */
let installed = false

/** 同一条消息在这个窗口期内只记一次；过了就重新记（现场会变） */
const THROTTLE_MS = 60_000
/** 单条文本上限：堆栈和 message 都可能很长，全写会挤掉别的现场 */
const MAX_TEXT = 2000
/**
 * 去重表的容量上限。**超过就整表清空**（照 `watchdog.ts · noteBlockEnd` 的 `size > 32` 写法）。
 *
 * ⚠️ 为什么必须有上限：键由**消息内容**构成，而只出现一次的消息**永远等不到第二次**去碰它
 * ⇒ 每次都是新键、60 秒节流对高基数 message **一次都不生效**（"AbortError: request 8f3a… cancelled"
 * 这类带 id 的、内置浏览器里嵌着 URL 与轮转 token 的，都是高基数）。
 * 不清扫 ⇒ 主进程内存单调上涨，**与磁盘轮转无关、不会自己停**（09-28 独立审查抓出）。
 */
const MAX_KEYS = 512

/**
 * 收哪两档：**warning 与 error**。info / verbose / debug 不进。
 *
 * ⚠️ **两种 level 形态都要认**（09-28 查证 Electron 35.0 breaking-changes）：
 * - Electron ≤34 传**数字**：0 verbose / 1 info / 2 warning / 3 error；
 * - Electron **≥35 改传 Event 对象**，`level` 变成**字符串** `'info' / 'warning' / 'error' / 'debug'`。
 * 只认数字的话，升级 Electron 那天这条通路会**静默全灭**（字符串与数字比恒不等，
 * 恒真 → 全部 return），而症状与"没做"一模一样。
 */
export function isRecordedConsoleLevel(level: unknown): boolean {
  if (typeof level === 'number') return level === 2 || level === 3
  if (typeof level === 'string') return level === 'warning' || level === 'error'
  return false
}

/**
 * 去重节流（**纯逻辑，时钟由外面注入**）。
 *
 * 为什么要把时钟做成参数：直接用 `Date.now()` 的话，"60 秒内不重复"这条判据**测不了** ——
 * 只能真等一分钟，而真等一分钟的测试等于没有测试。同本仓 `no-dead-wiring` 里
 * "冻结时钟直测落盘函数"是同一条纪律。
 *
 * 返回 `null` 表示"这条该被节流掉"；返回数字表示"距上次多少毫秒"（写进日志便于读）。
 */
export interface ThrottleState {
  lastAt: Map<string, number>
}

export function createThrottleState(): ThrottleState {
  return { lastAt: new Map() }
}

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

/** 载荷**逐字段自己定型**（不整体 stringify）——见 `RendererErrorReport` 的注释 */
export function sanitizeReport(raw: unknown): RendererErrorReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error'
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // 拒绝原因是对象（Promise.reject({code:1})）时给一句可读摘要，别直接 "[object Object]"
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

/** 两条来源共用一条记法 —— 拆开写就会漂（"改了一处忘了另一处"是本项目最常见的残片成因） */
function record(state: ThrottleState, what: string, detail: Record<string, unknown>, now: number): void {
  const key = `${what}::${detail['message'] ?? ''}::${detail['stack'] ?? ''}`
  const t = throttle(state, key, now)
  // 被节流时**一个字都不写**（每次都写一条"已节流"就是另一种刷屏）；
  // 累计次数在**下一条真记录**上以 `repeat` 带出 —— 那才是读者要的信息
  //（"这条每分钟炸 60 回"），且代价是每窗口期一条。
  if (!t.record) return
  log.error(what, { ...detail, sinceMs: t.sinceMs, repeat: t.repeat })
}

/**
 * 这个 webContents 是不是**自家窗口**（主窗口 / 设置窗口）。
 *
 * ⚠️ **结构化判据，不是靠 URL 猜**（09-28 独立审查抓出）：`getType()` 对 `BrowserWindow` 返回
 * `'window'`，对 `WebContentsView` 返回 `'browserView'`，对 DevTools 返回 `'devtools'`
 * （查证 Electron 文档 `contents.getType()`）。而内置浏览器（`main/browser.ts · initBrowser`）
 * 装的是**任意外部网址**，`url.includes('browser')` 那种猜法对它是失效的
 * —— 初始 `about:blank` 不含该子串，导航到 `https://github.com/…` 也不含。
 *
 * ★ **为什么必须排除浏览器视图**：它加载的是第三方页面，而远程页面爱用 `console.error`
 * 打印 URL、接口返回、偶发输入片段。照收的话，用户在一个站点上看到个报错，
 * 那个站点的 `?token=…` 就进了**用户正在教开发者发出去的**日志文件（`crash-guard` 的崩溃框
 * 原话就是"请将日志提供给开发者"）。⇒ 第三方内容一律不进日志。
 */
function isAppWindow(contents: WebContents): boolean {
  try {
    return contents.getType() === 'window'
  } catch {
    return false
  }
}

/**
 * 应用就绪后调用。**应用就绪后调用**（依赖 `initLogger`，故紧随其后）。
 * 幂等：重复调用不会叠加监听器（否则一个窗口会记好几份）。
 */
export function installRendererErrorReporting(): void {
  if (installed) return
  installed = true

  const state = createThrottleState()
  const now = (): number => Date.now()

  // ① console.error / console.warn —— 抓"有人已经打了日志但没人看"的中间态。
  //    挂 `web-contents-created` 一次罩住所有窗口，attach 内部再按来源筛。
  app.on('web-contents-created', (_e, contents) => {
    if (!isAppWindow(contents)) {
      // 这个取舍要**留痕**：否则下一个读代码的人会以为"浏览器视图漏挂了"是缺陷
      log.info('非自家窗口不挂渲染层错误监听（第三方页面内容不进日志）', {
        type: safeType(contents)
      })
      return
    }
    attach(contents)
  })

  // ② 渲染层 window.onerror / unhandledrejection（页面装的监听，走 send 上报）
  ipcMain.on(IPC.rendererError, (e, raw: unknown) => {
    const sender = e.sender
    // 来源校验：只收自家两个窗口的 webContents。第三方网页拿不到 preload 的桥（不挂），
    // 但校验是零成本的，且把"这条从哪来"这件事变成显式判定而不是默认信任。
    if (!isAppWindow(sender)) {
      log.warn('丢弃一条来源不明窗口的渲染层上报', { type: safeType(sender) })
      return
    }
    const report = sanitizeReport(raw)
    if (!report) {
      // ⚠️ **丢弃也必须留痕**：静默丢弃正是这条通路立项要消灭的形态
      //   （"app.log 零命中 = 没有探针"）。上游发错形状时零记录的话，
      //   现场会重演一次"什么都没有"。
      log.warn('丢弃了一条无法解析的渲染层上报', { got: typeof raw })
      return
    }
    record(
      state,
      report.kind === 'error' ? '渲染进程未捕获异常' : '渲染进程未处理的 Promise 拒绝',
      { ...report, window: describeWebContents(sender) },
      now()
    )
  })

  function attach(contents: WebContents): void {
    // ⚠️ **双形态签名**（查证 Electron 35.0 breaking-changes）：
    //   ≤34 是 `(event, level, message, line, sourceId)` 且 level 为**数字**；
    //   ≥35 改成 `({ level, message, lineNumber, sourceId, frame })` 且 level 为**字符串**。
    //   这里不写死五参 —— 升级 Electron 那天不会静默全灭。
    contents.on('console-message', (...args: unknown[]) => {
      const [first, ...rest] = args
      let level: unknown
      let message = ''
      let line = 0
      let source = ''
      if (typeof rest[0] === 'number') {
        // ≤34 形态
        level = rest[0]
        message = typeof rest[1] === 'string' ? rest[1] : ''
        line = typeof rest[2] === 'number' ? rest[2] : 0
        source = typeof rest[3] === 'string' ? rest[3] : ''
      } else {
        // ≥35 形态：细节挂在 Event 上
        const ev = (first ?? {}) as Record<string, unknown>
        level = ev['level']
        message = typeof ev['message'] === 'string' ? (ev['message'] as string) : ''
        line = typeof ev['lineNumber'] === 'number' ? (ev['lineNumber'] as number) : 0
        source = typeof ev['sourceId'] === 'string' ? (ev['sourceId'] as string) : ''
      }
      if (!isRecordedConsoleLevel(level)) return
      // dev 态 HMR 的那条提示是开发工具的正常输出，不是错误
      if (!app.isPackaged && /Download the React DevTools/.test(message)) return
      record(
        state,
        isErrorLevel(level) ? '渲染层 console.error' : '渲染层 console.warn',
        {
          message: oneLine(message),
          source: oneLine(source, 300),
          line,
          window: describeWebContents(contents)
        },
        now()
      )
    })
  }

  log.info('渲染层错误上报已装载（console-message + renderer:error；仅自家窗口）')
}

function isErrorLevel(level: unknown): boolean {
  return level === 3 || level === 'error'
}

function safeType(contents: WebContents): string {
  try {
    return contents.getType()
  } catch {
    return '(取不到类型)'
  }
}

/**
 * 窗口身份：**按 registry 登记的角色**比，不是靠 URL 猜（多窗口铁律，与
 * `window-registry.ts` 文件头写着要消灭的那类做法同源）。取不到就写"其他窗口"，
 * 不猜。
 */
function describeWebContents(contents: WebContents): string {
  try {
    if (contents.isDestroyed()) return '(已销毁的窗口)'
    if (getWindow('main')?.webContents === contents) return '主窗口'
    if (getWindow('settings')?.webContents === contents) return '设置窗口'
    return '其他窗口'
  } catch {
    return '(取不到窗口身份)'
  }
}
