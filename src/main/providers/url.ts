// baseURL 归一化 —— /v1 拼接是接入模型的头号 404 来源（见 DIARY/专题-模型接入配置.md）。
// 约定：去掉结尾斜杠；用户没写 /v1 就自动补上。OpenAI 兼容与 Anthropic 都按 /v1/<path> 走。

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

export function resolveApiUrl(baseURL: string, path: string): string {
  const base = normalizeBaseURL(baseURL)
  const suffix = path.startsWith('/') ? path : `/${path}`
  return base.endsWith('/v1') ? `${base}${suffix}` : `${base}/v1${suffix}`
}
