import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// 用 process.cwd() 锚定项目根：npm 脚本固定从根目录运行，比 __dirname 可靠
//（vite 会把配置打包到临时目录执行，__dirname 会失真）。
const r = (p: string): string => resolve(process.cwd(), p)

// ⚠️ WorkBuddy 等 AI 终端宿主给 node 注入 safe-delete 钩子，会拦下 vite emptyOutDir 的批量删除：
// 设 JSL_NO_EMPTY_OUT_DIR=1 跳过自清空，改由构建前手动清目录；正常终端 / CI 不设，行为不变。
const noEmptyOutDir = process.env['JSL_NO_EMPTY_OUT_DIR'] === '1'

// ── CSP 安全基线（plan8 R3）────────────────────────────────────────────────
// 用 meta 标签而非 session 级 webRequest 注入：浏览器面板（WebContentsView）是**独立
// WebContents、加载任意外部站点**，注在 defaultSession 上会把所有网页一起拦死。
// 分开发/生产两套：开发态 HMR 要 ws、Fast Refresh 注内联脚本，用生产那套会把开发打死。
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'", // 生产产物仅一个外部 module script，无内联
  // ⚠️ style-src 两侧的放宽是终端**逼出来**的（真渲染门禁 + 真 Chromium 探针实测，2026-09-13）：
  //    · xterm 运行时往 DOM 插 `<style>`（主题色 / 字体 / 行列尺寸对齐）→ 归 style-src-elem；
  //      16 色 palette（`\x1b[31m` 这种）走类名 `xterm-fg-N`，规则出自同一个 `<style>`，也归 elem。
  //    · xterm 的 `setAttribute('style', …)`（`_addStyle()` 的 3 个调用点：真彩前景 / 真彩背景 /
  //      最低对比度修正）→ 归 style-src-attr；同一条还拦掉 monaco 的 diff 余量装饰
  //      （拿不到 `position:absolute` 就定位不到正确行；代码级证据，未做像素级实测）。
  //    ⚠️ 被拦的是这两类**属性级**写入，不是"颜色全没了"：attr 收成 'none' 时 16 色照常显示
  //      （那条断言仍绿），降级的是真彩。实测一次门禁：172 条 `style-src-attr` 拒绝（去重后
  //      16 处，来源确认是本应用 bundle 的 monaco + xterm）→ 0 条。
  //    ⚠️ 别以为还能再收窄：`el.style.x=` / `cssText` / `setProperty()` 属 CSSOM，**本就不受 CSP
  //      管辖**（探针实测拦不住）；这一档也没有更窄的写法 —— 哈希要配 `'unsafe-hashes'` 且只认
  //      静态值，nonce 对内联属性无效。上游 xterm.js#1335 / #4133 开着长期 issue 至今未解。
  //    放行的底气：`script-src 'self'` 一个字不动，且渲染层零 HTML 注入原语（无
  //      dangerouslySetInnerHTML / innerHTML / rehype-raw，已 grep 核实）。
  // ⚠️ `style-src 'self'` 现在只是兜底（elem / attr 已显式给出，CSP3 各自独立回退），
  //    留着是为了未列出的取用途径仍有下界。
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // markdown 外链图片（README 常见），仅图片只读
  "font-src 'self' data:",
  "connect-src 'self'", // 渲染进程零直连网络，全部经 IPC 交主进程（已 grep 确认）
  "media-src 'self'",
  "object-src 'none'", // 禁插件（Electron 不需要）
  "base-uri 'self'", // 防 <base> 劫持相对路径
  "form-action 'none'",
  // ⚠️ 必须放行自定义协议，否则 HTML 沙箱预览画不出来：`srcdoc` / `blob:` / `data:` 都算
  //    「本地 scheme」，子文档**继承父页策略**，上面那条 style-src 'self' 会把预览里的内联
  //    样式全砍掉（实测三种写法渲染出来全是白色骨架）。走**真实 scheme** 才拿得到全新策略
  //    容器，由预览响应头自己断脚本 / 断网（真源 src/shared/html-preview.ts）；只放行自家协议。
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
