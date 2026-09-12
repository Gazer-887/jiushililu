import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// 本配置位于 config/ 子目录（根目录整洁铁律，见 AGENTS.md 第三节）。
// 用 process.cwd() 锚定项目根：npm 脚本固定从根目录运行，比 __dirname 可靠
//（vite 会把配置文件打包到临时目录执行，__dirname 会失真）。
const r = (p: string): string => resolve(process.cwd(), p)

// WorkBuddy 等 AI 终端宿主会给 node 注入 safe-delete 钩子，vite 的 emptyOutDir
// 批量删除会被拦。设 JSL_NO_EMPTY_OUT_DIR=1 跳过自清空，配合构建前手动清目录。
// 正常终端 / CI 不设此变量，行为不变。
const noEmptyOutDir = process.env['JSL_NO_EMPTY_OUT_DIR'] === '1'

// ── CSP 安全基线（plan8 R3）────────────────────────────────────────────────
//
// 为什么用 meta 标签而不是 session 级 webRequest 注入：
//   浏览器面板（WebContentsView）是**独立 WebContents，加载任意外部站点**，
//   若在 defaultSession 上注入 CSP，会把所有网页一起拦死。meta 标签只作用于
//   主窗口这一个文档，互不干扰。
//
// 为什么分开发/生产两套：
//   开发态 vite HMR 需要 ws 连接，React Fast Refresh 会注入内联脚本 ——
//   用生产那套会直接把开发环境打死。生产态产物无内联 script/style，可以严格。
//
// 各指令依据（均已核对代码事实）：
//   script-src 'self'       —— 生产产物仅一个外部 module script，无内联
//   style-src  'self'       —— CSS 经 <link> 外链；React 的 style={{}} 走 DOM API，不受 CSP 限制
//   connect-src 'self'      —— 渲染进程**零直连网络**（全部经 IPC 交主进程），已 grep 确认
//   img-src    https:       —— 允许 markdown 里的外链图片（README 常见），仅图片、只读
//   object-src 'none'       —— 禁插件（Electron 不需要）
//   base-uri   'self'       —— 防 <base> 劫持相对路径
//   frame-src  'self' jsl-preview: —— **HTML 沙箱预览**专用。
//     为什么必须放行自定义协议：`srcdoc`/`blob:`/`data:` 都是「本地 scheme」，
//     子文档**继承父页策略**，我们这条 `style-src 'self'` 会把预览里的内联样式
//     全部砍掉（实测三种写法渲染出来全是白色骨架）。走**真实 scheme** 才拿得到
//     全新策略容器，由预览响应头自己断脚本/断网（真源 src/shared/html-preview.ts）。
//     放行范围仍是"自家", 不放任何外部站点/通配协议。
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'self' jsl-preview:"
].join('; ')

const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Fast Refresh 注入内联脚本
  "style-src 'self' 'unsafe-inline'", // vite dev 注入内联样式
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:*", // HMR websocket
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'self' jsl-preview:"
].join('; ')

/** 仅向主窗口文档注入 CSP meta（浏览器面板不受影响） */
function cspPlugin(): Plugin {
  return {
    name: 'jsl-csp',
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? CSP_DEV : CSP_PROD // ctx.server 存在 = dev
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared'), '@main': r('src/main') }
    },
    build: {
      outDir: r('out/main'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared') }
    },
    build: {
      outDir: r('out/preload'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared'), '@': r('src/renderer/src') }
    },
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/renderer/index.html') } }
    }
  }
})
