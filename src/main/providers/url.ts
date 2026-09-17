// baseURL 归一化 —— /v1 拼接是接入模型的头号 404 来源（见 DIARY/专题-模型接入配置.md）。
// 约定：去掉结尾斜杠；末尾没有版本段就补 /v1。OpenAI 兼容与 Anthropic 都按 /<版本段>/<path> 走。

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/** 末尾版本段：/v1 · /v3 · /v4 · /v1beta …。判据不能写死 /v1 —— 智谱 /api/paas/v4、火山 /api/v3 会被再插一层 /v1 成 404（plan47 S0，D-105） */
const TRAILING_VERSION_SEGMENT = /\/v\d+[a-z0-9]*$/

export function resolveApiUrl(baseURL: string, path: string): string {
  const base = normalizeBaseURL(baseURL)
  const suffix = path.startsWith('/') ? path : `/${path}`
  return TRAILING_VERSION_SEGMENT.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`
}
