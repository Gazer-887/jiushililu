// 导航守卫的 URL 判定（plan8 R3 安全基线）
//
// 抽成**纯函数、不 import electron** 是刻意的：主进程里的判定逻辑若与 electron 耦合，
// 单测就跑不了（CI 无 Electron 二进制），安全关键代码就成了"只能靠肉眼 review"的部分。
// 与 agent/browser-bridge 的做法一致 —— 纯逻辑与宿主分开。

/**
 * 是否属于「应用自己的页面」——只有这类 URL 允许主窗口导航过去。
 *
 * 判定用 **origin 比对**（协议 + 主机 + 端口），**不用字符串前缀**：
 * 前缀匹配会把 `http://localhost:51730` 甚至 `http://localhost:5173.evil.com`
 * 误判为内部地址（后者只需攻击者注册一个同前缀域名即可绕过防线）。
 * 此坑由单测当场抓出，见 tests/unit/url-guard.test.ts。
 *
 * @param url    待判定的 URL
 * @param devUrl 开发态 vite 服务地址（`ELECTRON_RENDERER_URL`）；生产态传 undefined
 */
export function isInternalUrl(url: string, devUrl?: string): boolean {
  if (url.startsWith('file://')) return true
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false // URL 解析失败一律视为外部
  }
}

/**
 * 是否应交给**系统浏览器**打开。
 *
 * 只放行 http/https：把 `file:` / `javascript:` / `data:` 等交给 `shell.openExternal`
 * 是危险的（可触发本地文件或脚本执行），一律拒绝。
 */
export function isExternallyOpenable(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
