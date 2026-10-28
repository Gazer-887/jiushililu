// baseURL 归一化 —— /v1 拼接是接入模型的头号 404 来源（见 DIARY/专题-模型接入配置.md）。
// 约定：去掉结尾斜杠；路径任一分段已是版本段（v1/v1beta/v3/v4…）就不再补版本段，
// 补全规则按最终 URL 断言（S3-00C 官方端点取证 EP-1~6）：
//   - Gemini 兼容面 /v1beta/openai 已含版本段 → /v1beta/openai/chat/completions（不再补 /v1，F-01）
//   - DeepSeek/Kimi Code/Moonshot/MiniMax 的 /anthropic、/coding、/step_plan、/inference/go/anthropic
//     无版本段 → 补 /v1/messages（官方 endpoint 逐字一致）
//   - OpenCode Go models 走 /inference/go/v1/models（与聊天 base 分列，由模板元数据表达）

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/** 末尾版本段：/v1 · /v3 · /v4 · /v1beta …。判据不能写死 /v1 —— 智谱 /api/paas/v4、火山 /api/v3 会被再插一层 /v1 成 404（plan47 S0，D-105） */
const TRAILING_VERSION_SEGMENT = /\/v\d+[a-z0-9]*$/

/** 路径任一分段形如 v1/v1beta/v3…（整段匹配，openv1 这类词尾不误伤）即为已带版本（S3-10B F-01） */
function hasVersionSegment(base: string): boolean {
  return base
    .replace(/^https?:\/\//, '')
    .split('/')
    .slice(1)
    .some((seg) => /^v\d+[a-z0-9]*$/i.test(seg))
}

export function resolveApiUrl(baseURL: string, path: string): string {
  const base = normalizeBaseURL(baseURL)
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (TRAILING_VERSION_SEGMENT.test(base)) return `${base}${suffix}`
  // 已在路径中段声明版本（如 Gemini 兼容面 /v1beta/openai）→ 直接拼接，不再插 /v1
  if (hasVersionSegment(base)) return `${base}${suffix}`
  return `${base}/v1${suffix}`
}
