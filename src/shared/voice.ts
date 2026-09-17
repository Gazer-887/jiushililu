/**
 * 语音输入（plan45）—— 共享类型与纯函数。
 * 判据（§〇 推论）：客户端零后处理、零内置端点/Key；识别、标点、分段全归端点。
 */

export interface VoiceConfig {
  /** OpenAI 兼容 base（如 http://127.0.0.1:7101/v1）；空 = 未配置（按钮置灰） */
  endpoint: string
  /** 可选模型名；留空 = 端点默认 */
  model: string
  /** 缺省 auto（语言判定归服务端） */
  language: 'auto' | 'zh' | 'en'
  /** 一次性隐私披露是否已确认（决策 4） */
  disclosureAccepted: boolean
  /** Key 是否已设置（只回布尔——Key 本体永不出主进程） */
  hasApiKey: boolean
}

export interface VoicePatch {
  endpoint?: string
  model?: string
  language?: 'auto' | 'zh' | 'en'
  disclosureAccepted?: boolean
  /** undefined = 不动；null = 清除；string = 设置（主进程负责加密） */
  apiKey?: string | null
}

export type VoiceTranscribeResult = { ok: true; text: string } | { ok: false; reason: string }

/** 归一化转写 URL：base 去尾斜杠，补 `/audio/transcriptions`（版本段已在 base 里，与 providers/url.ts 的教训相反——这里不猜版本号） */
export function transcribeUrl(endpoint: string): string | null {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  // 只认 http/https；本地回环是主用例，**不适用** fetch_url 的 SSRF 拦截表
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname.endsWith('/audio/transcriptions')) return trimmed
  return `${trimmed}/audio/transcriptions`
}

/** 录音时长决策（决策 2 的边界，纯函数供单测）：太短=误触丢弃；到上限=自动停 */
export type RecordDecision = 'too-short' | 'ok' | 'auto-stop'
export const MIN_RECORD_MS = 500
export const MAX_RECORD_MS = 60_000

export function decideRecord(durationMs: number): RecordDecision {
  if (durationMs >= MAX_RECORD_MS) return 'auto-stop'
  if (durationMs < MIN_RECORD_MS) return 'too-short'
  return 'ok'
}
