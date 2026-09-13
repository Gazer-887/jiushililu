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
  // ⚠️ 终端**逼出了 `style-src` 两侧的放宽**（plan7 批 C），不是随手加的。
  //    实测（真渲染门禁 + 真 Chromium 探针，2026-09-13）：
  //
  //    ① xterm 运行时会往 DOM 里插 `<style>` 元素（核心 4 处：主题色 / 字体 / 行列尺寸对齐）
  //       —— 归 `style-src-elem` 管；
  //    ② xterm 里也有 `setAttribute('style', …)`（`_addStyle()` 的 **3 个调用点**：
  //       **真彩**前景 / 真彩背景 / 最低对比度修正）—— 归 `style-src-attr` 管。
  //       ⚠️ **机理必须写准**（第一版写错过，被审查当场纠正）：
  //         · **16 色 palette**（`\x1b[31m` 这种）走的是**类名** `xterm-fg-N`，规则来自 xterm
  //           运行时注入的 `<style>` → 归 **`style-src-elem`**；
  //         · **真彩**（`\x1b[38;2;r;g;b`）与对比度修正走 `setAttribute` → 归 **`style-src-attr`**。
  //       实测印证：把 attr 收成 `'none'` 后 16 色**照常显示**（那条断言仍绿），真彩会降级。
  //       所以理由不是"颜色全没了"，而是"**真彩输出降级**"+"**monaco 余量装饰错位**"+
  //       "别让 172 条合法写入被拒"。
  //    ③ 同一条规矩还拦掉了 **monaco 的 diff 余量装饰**
  //       （`marginElement.setAttribute("style", 'position:absolute;top:…px;…')`）——
  //       这是**批 B 就带进来的既有缺陷**，只是那时的门禁从不断言 CSP 违规，所以没人发现。
  //       ⚠️ 证据级别：**代码级**（元素拿不到 `position:absolute` 就不会被定位到正确行），
  //       没有做像素级实测 —— 别把它当成"已验证的视觉回归"。
  //
  //    实测数据：放开之前一次门禁跑出 **172 条 `style-src-attr` 拒绝（去重后 16 处，
  //    来源确认是应用自己的 bundle：monaco + xterm）**；放开后降到 **0 条**。
  //
  //    ⚠️ 边界必须写清楚，否则后人会以为"还能再收窄"：
  //      · `el.style.x = y` / `el.style.cssText = …` / `setProperty()` 这些 **CSSOM** 写法
  //        **本来就不受 CSP 管辖**（探针实测：拦不住）。所以 React 的 `style={{}}` 一直是好的 ——
  //        被拦的只有"**属性级**"的两种写法：`setAttribute('style', …)` 与 markup 里的 `style="…"`。
  //      · 这一档**没有更窄的写法**：哈希要配 `'unsafe-hashes'` 且只认**静态**值，
  //        而 xterm / monaco 写进去的是逐帧变化的颜色与坐标；nonce 对内联属性无效。
  //      · 另一条更"干净"的路（让 xterm 改用 `adoptedStyleSheets` 之类）**押不得**：
  //        上游为这件事开过长期 issue 且**至今未解** —— xterm.js#1335「Avoid inline-styling
  //        to meet tighter CSP」、xterm.js#4133「DOM renderer triggers CSP warnings about
  //        unsafe-inline styles」。也就是说这不是本项目的用法问题，而是**渲染器的结构性事实**，
  //        等上游改没有依据。
  //
  // 为什么这样放行是**可接受**的：`script-src 'self'` **一个字不动** ——
  // 决定"能不能执行代码"的是它，注入样式执行不了脚本；而渲染层**没有任何 HTML 注入原语**
  // （零 `dangerouslySetInnerHTML` / `innerHTML` / `rehype-raw` —— 已 grep 核实），
  // 也就是"往页面里塞带 style 的 markup"这条攻击路径本来就不存在。
  //
  // ⚠️ 顺带一句：`style-src 'self'` 现在**只是兜底**（`elem` / `attr` 两档都显式给了，
  // CSP3 各自独立回退，它实际不再被查询）。留着是为了任何未列出的 style 取用途径仍有下界。
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
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
