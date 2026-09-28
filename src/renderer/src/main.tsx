import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SettingsWindow from './views/SettingsWindow'
import './styles.css'
import { ensureI18n } from './i18n'

/*
 * 渲染入口**按窗口分叉**（2026-09-13，设置独立窗口）。
 *
 * 主进程 loadURL/loadFile 时带 hash 告诉这里"这个窗口该挂谁"：
 *   - 无 hash（或不是 settings）→ 主窗口 `App`
 *   - `#/settings`              → 设置窗口 `SettingsWindow`
 *
 * ⚠️ **为什么用 hash 分叉、而不是另做一个 HTML 入口**：electron-vite 的渲染产物入口是单一
 *    `index.html`。另建入口要动构建配置、多出一份 bundle（monaco/xterm 那一大坨都会被打两遍），
 *    而两个窗口**共用同一份代码**，差异只是"挂哪个根组件" —— hash 是这件事最轻的表达。
 * ⚠️ **必须在这里分叉，不能"先挂 App 再让 App 判断"**：主窗口那一层挂在 `App` 上的
 *    流式订阅 / 会话落盘握手 / 工作台，对设置窗口来说**全是无关开销**（设置窗口没有会话）。
 */

/**
 * 渲染层未捕获异常的上报（K58）。
 *
 * **为什么装在这里而不是 preload** —— 实测结论，不是推测（09-28）：
 * 本项目窗口是 `contextIsolation:true` + `sandbox:true`，**sandboxed preload 在隔离世界
 * 注册的 `window.addEventListener('error'/'unhandledrejection')` 收不到主世界的事件**。
 * 判据：preload 安装监听时打的标记进了 `app.log`（说明 preload 的 console 确实被转发，
 * 不是"转发不到"造成的假象），而监听器**触发**时打的标记**零命中**。
 * ⇒ 监听必须装在页面（本就在主世界）。入口是唯一合适的位置：两个窗口都经过这里，
 * 且它在 React 挂载**之前**（否则首屏就崩的异常会漏掉）。
 *
 * ⚠️ 这里**只报不算**：节流与去重在主进程（`main/renderer-errors.ts`），
 * 页面每抛一次就发一次 IPC 不算贵，但重复的同一条不该占日志。
 */
function installErrorReporting(): void {
  window.addEventListener('error', (ev: ErrorEvent) => {
    try {
      window.api.reportRendererError({
        kind: 'error',
        message: ev.message,
        // 堆栈是排查的命根子 —— 只报 message 等于只记"错了"不记"错在哪"。
        // 而 Chromium 把未捕获异常打进 console 时**只有 message**（K58 e2e 实测），
        // 这正是这条通路存在的理由。
        stack: ev.error instanceof Error ? (ev.error.stack ?? '') : '',
        source: ev.filename,
        line: ev.lineno,
        column: ev.colno
      })
    } catch {
      // 上报失败不能反过来让页面再炸一次
    }
  })

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    try {
      const reason: unknown = ev.reason
      // 拒绝原因可能是 Error、字符串、或任意对象（`Promise.reject({code:1})` 合法）。
      // ⚠️ **对象形状的原因不能只写一句"(非 Error 对象)"** —— 09-28 e2e 抓到的自造缺陷：
      // 那句话把 `Promise.reject({code:'探针标记'})` 里的线索**整个丢掉**，
      // 而"记了但没用"比不记更坏（读者以为日志里啥也没有，其实是有的）。
      // 与 `main/crash-guard.ts · describe()` 同口径：先试 JSON.stringify，失败才退占位。
      const isErr = reason instanceof Error
      const asText = (): string => {
        if (typeof reason === 'string') return reason
        try {
          return JSON.stringify(reason) ?? '(序列化为空)'
        } catch {
          return '(无法序列化，可能是循环引用)'
        }
      }
      window.api.reportRendererError({
        kind: 'unhandledrejection',
        message: isErr ? reason.message : asText(),
        stack: isErr ? (reason.stack ?? '') : '',
        source: '',
        line: 0,
        column: 0
      })
    } catch {
      // 同上
    }
  })
}

installErrorReporting()

const route = (): 'settings' | 'main' => {
  const h = window.location.hash.replace(/^#\/?/, '')
  return h.startsWith('settings') ? 'settings' : 'main'
}

const root = document.getElementById('root')
if (root) {
  const which = route()
  // 打好标记：样式与门禁都据此区分"这是设置窗口"，不必各自去解析 hash
  document.documentElement.dataset.window = which
  // 先同步初始化（默认中文）再渲染：否则第一帧没有 i18n 实例，t() 会露出 key —— 真语言随后由 loadUIPrefs 应用
  ensureI18n()
  createRoot(root).render(<React.StrictMode>{which === 'settings' ? <SettingsWindow /> : <App />}</React.StrictMode>)
}
