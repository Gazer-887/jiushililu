// 导航守卫的 URL 判定（plan8 R3 安全基线）—— 刻意做成**纯函数、不 import electron**：否则 CI 上
// （无 Electron 二进制）跑不了单测，安全关键逻辑就只能靠肉眼 review。

/**
 * 是否属于「应用自己的页面」——只有这类 URL 允许主窗口导航过去。
 * ⚠️ 必须走 **origin 比对**（协议 + 主机 + 端口），**不许用字符串前缀**：前缀会把
 * `http://localhost:5173.evil.com` 判成内部地址，攻击者注册个同前缀域名即可绕过。
 * @param devUrl 开发态 vite 地址（`ELECTRON_RENDERER_URL`）；生产态传 undefined
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
 * 是否应交给**系统浏览器**打开：只放行 http/https。
 * `file:` / `javascript:` / `data:` 交给 `shell.openExternal` 等于递出去一个本地文件或脚本执行，一律拒。
 */
export function isExternallyOpenable(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
