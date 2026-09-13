import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SettingsWindow from './views/SettingsWindow'
import './styles.css'

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

const route = (): 'settings' | 'main' => {
  const h = window.location.hash.replace(/^#\/?/, '')
  return h.startsWith('settings') ? 'settings' : 'main'
}

const root = document.getElementById('root')
if (root) {
  const which = route()
  // 打好标记：样式与门禁都据此区分"这是设置窗口"，不必各自去解析 hash
  document.documentElement.dataset.window = which
  createRoot(root).render(<React.StrictMode>{which === 'settings' ? <SettingsWindow /> : <App />}</React.StrictMode>)
}
