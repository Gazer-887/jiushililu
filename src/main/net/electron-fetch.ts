/**
 * 把 `net.fetch` 装进模型请求的网络出口（plan7 批 F2）。
 *
 * 这是**唯一** import electron 的网络文件 —— 分层的理由：
 * 架构守卫禁止单测 import 图里出现 electron，而 providers 的纯函数是要进单测的；
 * 故 `providers/http-client.ts` 只留一个可注入出口，由这里在 app ready 之后把真 `net.fetch` 装上去。
 *
 * ⚠️ **为什么非装它不可**：`session.setProxy()` 只作用于 Chromium 网络栈，而 Node 原生 `fetch`
 * （undici）走的是另一条 —— 不装，设置里的代理对模型请求**完全无效**，且失败方式是静默的
 * （界面显示已生效、日志无错、请求照直连）。实证：`scripts/probe-main-proxy.cjs`。
 */

import { net } from 'electron'
import { setHttpFetch, type HttpFetch } from '../providers/http-client'

/**
 * `net.fetch` 的 init 比标准 `RequestInit` 多几个 Chromium 专有字段，故这里做一次收窄 cast ——
 * 我们只用得到 method / headers / body / signal 这四项（`scripts/probe-main-net.cjs` 已逐项验过）。
 */
export function electronFetch(): HttpFetch {
  return (url, init) =>
    net.fetch(url, init as Parameters<typeof net.fetch>[1]) as unknown as Promise<Response>
}

/** 装上去。幂等：重复调用只是再装一次同一个实现 */
export function installElectronFetch(): void {
  setHttpFetch(electronFetch(), 'electron-net')
}
