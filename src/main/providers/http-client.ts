/**
 * 模型请求的网络出口（plan7 批 F2）—— 一处收口，全项目只有这里决定"请求走哪条栈"。
 *
 * **为什么非抽这一层不可（这是本批最要紧的一条）**：
 *   `session.defaultSession.setProxy()` 只对 **Chromium 网络栈**生效，而模型请求原来用的是
 *   **Node 原生 fetch（undici）** —— 两条栈互不相干。后果是一个**静默**的假象：设置里显示"已生效"、
 *   日志没有报错、请求照旧直连（然后在国内超时）。实证见 `scripts/probe-main-proxy.cjs`
 *   （`nodeFetchIgnoresProxy: true`）与 `scripts/probe-main-net.cjs`（配了代理后 net.fetch 拿到
 *   `PROXIED:`，Node fetch 仍然 `fetch failed`）。
 *
 * **为什么不是直接在 providers 里 `import { net } from 'electron'`**：
 *   架构守卫（`tests/unit/architecture.test.ts`）禁止单测 import 图里出现 electron，而 providers 的
 *   纯函数是被单测直接 import 的。故这里只留一个**可注入的出口**：默认回退到 Node 原生 fetch
 *   （与改造前行为一致，不会更差），由组合根在 app ready 后注入 `net.fetch`（那才吃代理）。
 *   副作用是**模型请求终于进得了单测**：注入一个假 fetch 就能覆盖 `streamChat`。
 *
 * ⚠️ **已知边界（将来会撞上）**：`net.fetch` 只在**主进程**可用。Agent 内核一旦真迁进
 *   `worker_threads`（AGENTS.md 里的既定方向），这条注入会失效 —— 届时要么把请求转发回主进程，
 *   要么给 Node fetch 显式配 agent。改之前先跑 `scripts/probe-main-net.cjs` 复验。
 */

/** 与 `fetch` 同形：可注入、可替换。刻意**不**引入 electron 的类型，保持本文件零平台依赖 */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

/** 当前用的是哪条栈 —— 日志与诊断要能一眼看出"配了代理到底有没有真的换栈" */
export type HttpFetchKind = 'node-fetch' | 'electron-net' | 'injected'

let injected: HttpFetch | null = null
let kind: HttpFetchKind = 'node-fetch'

/**
 * 注入实现（组合根在 app ready 后调）。传 `null` 恢复默认。
 * ⚠️ 默认实现 = Node 原生 fetch：**不吃代理**。它是"没注入成功时也不比改造前差"的兜底，
 *    不是正确终态 —— 正确终态是注入 `net.fetch`。
 */
export function setHttpFetch(fn: HttpFetch | null, nextKind: HttpFetchKind = 'injected'): void {
  injected = fn
  kind = fn === null ? 'node-fetch' : nextKind
}

export function httpFetchKind(): HttpFetchKind {
  return kind
}

export function httpFetch(url: string, init: RequestInit): Promise<Response> {
  return injected === null ? fetch(url, init) : injected(url, init)
}
