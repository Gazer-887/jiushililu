/**
 * 语音转写调用（plan45 决策 1）—— OpenAI 兼容 `/v1/audio/transcriptions` 的极简客户端。
 *
 * 判据：客户端**零后处理**（标点/分段/ITN 全归端点），**不内置任何地址与 Key**。
 * 网络出口走 `providers/http-client` 的 `httpFetch`（代理生效链），不直接用 Node fetch。
 */
import { httpFetch } from '../providers/http-client'
import { transcribeUrl } from '@shared/voice'
import type { VoiceTranscribeResult } from '@shared/voice'

export interface TranscribeInput {
  endpoint: string
  apiKey: string | null
  model: string
  language: 'auto' | 'zh' | 'en'
  audio: Uint8Array
  mime: string
}

const REQUEST_TIMEOUT_MS = 30_000

function extForMime(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return 'm4a'
  return 'webm'
}

/** 组 multipart 请求体。抽出成纯函数供单测（FormData 在测试里也可构造） */
export function buildTranscribeForm(input: TranscribeInput): FormData {
  const form = new FormData()
  const blob = new Blob([Buffer.from(input.audio)], { type: input.mime })
  form.append('file', blob, `voice.${extForMime(input.mime)}`)
  if (input.model.length > 0) form.append('model', input.model)
  if (input.language !== 'auto') form.append('language', input.language)
  return form
}

/** 响应 sanitize：OpenAI 口径是 `{ text }`；个别实现返回 `{ transcript }` 或纯文本，都如实接住 */
export function pickTranscriptText(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>
    for (const key of ['text', 'transcript', 'result']) {
      const v = j[key]
      if (typeof v === 'string') return v
    }
    return null
  } catch {
    return trimmed
  }
}

export async function transcribe(input: TranscribeInput): Promise<VoiceTranscribeResult> {
  const url = transcribeUrl(input.endpoint)
  if (url === null) return { ok: false, reason: '端点地址无效或未配置（设置页 → 语音输入）' }
  if (input.audio.byteLength === 0) return { ok: false, reason: '录音数据为空' }
  const headers: Record<string, string> = {}
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
  try {
    const res = await httpFetch(url, {
      method: 'POST',
      body: buildTranscribeForm(input),
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const raw = await res.text()
    if (!res.ok) return { ok: false, reason: `端点返回 ${res.status}：${raw.slice(0, 200)}` }
    const text = pickTranscriptText(raw)
    if (text === null) return { ok: false, reason: '端点返回格式不含转写文本（期望 OpenAI 兼容 JSON 的 text 字段）' }
    return { ok: true, text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = msg.includes('timeout') || msg.includes('abort') ? '（超时，检查端点是否在线）' : ''
    return { ok: false, reason: `转写请求失败：${msg}${hint}` }
  }
}

/** 100ms 16bit 单声道静音 WAV（测试连接用；纯函数，无依赖） */
export function silentWav100ms(): Uint8Array {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * 0.1)
  const dataSize = samples * 2
  const buf = new Uint8Array(44 + dataSize)
  const view = new DataView(buf.buffer)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) buf[off + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  return buf
}

/** 测试连接：静音音频走一次真转写。返回 ok 只说明"端点可达且返回格式正确" */
export async function testVoiceEndpoint(input: Omit<TranscribeInput, 'audio' | 'mime'>): Promise<VoiceTranscribeResult> {
  const r = await transcribe({ ...input, audio: silentWav100ms(), mime: 'audio/wav' })
  if (r.ok) return { ok: true, text: '端点可达，返回格式正确（静音输入转写为空属正常）' }
  return r
}
