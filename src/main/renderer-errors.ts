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
 * - 全部经 `log.ts` 的 `scrub()` 脱敏（Key / Bearer / token 形状）。
 * - 全部经 `throttle` 去重：同一条在窗口期内只记一次，第二次起只累加计数。
 *   ⚠️ 没有节流的话，一个渲染循环异常能把 `app.log` 刷爆并触发轮转，
 *   **把真正的现场挤掉** —— 记录手段本身成了故障放大器。
 *
 * **不做什么**：不弹窗。渲染层错误大多可恢复（一次交互失败而已），弹窗会骚扰 ——
 * `crash-guard` 对 `unhandledRejection` 也是这个口径（那里写明"常为可恢复的操作失败"）。
 */
import { app, ipcMain, type WebContents } from 'electron'
import { createLogger } from './log'
import { IPC, type RendererErrorReport } from '@shared/ipc'

const log = createLogger('renderer-error')

/** 同一条消息在这个窗口期内只记一次；过了就重新记（现场会变） */
const THROTTLE_MS = 60_000
/** 单条文本上限：堆栈和 message 都可能很长，全写会挤掉别的现场 */
const MAX_TEXT = 2000

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
): { record: true; sinceMs: number } | { record: false; repeat: number } {
  const prev = state.lastAt.get(key)
  if (prev !== undefined && now - prev < windowMs) {
    // 用计数而不是再存时间：连着来 100 次也只占一个 map 项（否则 map 会被同一条撑爆）
    const key2 = `${key}#n`
    const n = (state.lastAt.get(key2) ?? 0) + 1
    state.lastAt.set(key2, n)
    return { record: false, repeat: n }
  }
  state.lastAt.set(key, now)
  // 重新计时 ⇒ 旧的计数作废（否则会报一个隔了很久的重复次数）
  state.lastAt.delete(`${key}#n`)
  return { record: true, sinceMs: prev === undefined ? -1 : now - prev }
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
function record(
  state: ThrottleState,
  what: string,
  detail: Record<string, unknown>,
  now: number
): void {
  const key = `${what}::${detail['message'] ?? ''}::${detail['stack'] ?? ''}`
  const t = throttle(state, key, now)
  if (!t.record) {
    log.debug('重复的渲染层错误已节流', { what, repeat: t.repeat })
    return
  }
  log.error(what, { ...detail, sinceMs: t.sinceMs })
}

/**
 * 装渲染层错误通路。**应用就绪后调用**（依赖 `initLogger`，故紧随其后）。
 * 幂等：重复调用不会叠加监听器（否则一个窗口会记好几份）。
 */
export function installRendererErrorReporting(): void {
  if ((app as unknown as { __jslReported?: boolean }).__jslReported) return
  ;(app as unknown as { __jslReported?: boolean }).__jslReported = true

  const state = createThrottleState()
  const now = (): number => Date.now()

  // ① console.error / console.warn —— 抓"有人已经打了日志但没人看"的中间态
  app.on('web-contents-created', (_e, contents) => {
    attach(contents)
  })

  // ② 渲染层 window.onerror / unhandledrejection（preload 装的监听，走 send 上报）
  ipcMain.on(IPC.rendererError, (e, raw: unknown) => {
    const report = sanitizeReport(raw)
    if (!report) return
    record(
      state,
      report.kind === 'error' ? '渲染进程未捕获异常' : '渲染进程未处理的 Promise 拒绝',
      { ...report, window: describeWebContents(e.sender) },
      now()
    )
  })

  function attach(contents: WebContents): void {
    // dev 态的 HMR / React DevTools 噪声不进日志（那是开发工具的正常输出）
    if (!contents.isDevToolsOpened() && process.env['ELECTRON_RENDERER_URL']) {
      // 仍要挂：dev 态的错误同样值得记。只是下面会多一道 dev 噪声过滤。
    }
    contents.on('console-message', (_ev, level, message, line, sourceId) => {
      if (!app.isPackaged && /Download the React DevTools/.test(message)) return
      // level: 0=verbose 1=info 2=warning 3=error（Electron 文档口径）
      // ⚠️ **不收 verbose / info**：用户正文最可能出现在 console.log 里，而量最大。
      if (level !== 2 && level !== 3) return
      record(
        state,
        level === 3 ? '渲染层 console.error' : '渲染层 console.warn',
        {
          message: oneLine(message),
          source: oneLine(sourceId ?? '', 300),
          line: typeof line === 'number' ? line : 0,
          window: describeWebContents(contents)
        },
        now()
      )
    })
  }

  log.info('渲染层错误上报已装载（console-message + renderer:error）')
}

/** 窗口身份：按 URL 判角色（多窗口铁律：不靠 `getAllWindows()[0]`） */
function describeWebContents(contents: WebContents): string {
  try {
    if (contents.isDestroyed()) return '(已销毁的窗口)'
    const url = contents.getURL()
    if (url.includes('#/settings')) return '设置窗口'
    if (url.includes('browser')) return '内置浏览器'
    return '主窗口'
  } catch {
    return '(取不到窗口身份)'
  }
}
