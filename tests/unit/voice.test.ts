// 语音输入纯函数单测（plan45）：URL 归一化、录音时长边界、转写响应 sanitize、静音 WAV 结构。
import { describe, expect, it } from 'vitest'
import { decideRecord, transcribeUrl, MIN_RECORD_MS, MAX_RECORD_MS } from '@shared/voice'
import { pickTranscriptText, silentWav100ms, buildTranscribeForm } from '@main/voice/transcribe'
import type { TranscribeInput } from '@main/voice/transcribe'

describe('transcribeUrl（决策 1：OpenAI 兼容路径拼接）', () => {
  it('base 带 /v1 → 补 /audio/transcriptions；去尾斜杠', () => {
    expect(transcribeUrl('http://127.0.0.1:7101/v1/')).toBe('http://127.0.0.1:7101/v1/audio/transcriptions')
  })
  it('已含完整路径 → 原样（幂等，不叠两段）', () => {
    expect(transcribeUrl('https://api.x/v1/audio/transcriptions')).toBe('https://api.x/v1/audio/transcriptions')
  })
  it('非 http(s) / 空 / 坏 URL → null（不猜版本号：/v4 之类的版本段原样保留）', () => {
    expect(transcribeUrl('https://api.bigmodel.cn/api/paas/v4')).toBe('https://api.bigmodel.cn/api/paas/v4/audio/transcriptions')
    expect(transcribeUrl('')).toBeNull()
    expect(transcribeUrl('ftp://a/b')).toBeNull()
    expect(transcribeUrl('not a url')).toBeNull()
  })
})

describe('decideRecord（决策 2 边界）', () => {
  it('<0.5s 误触丢弃；到 60s 自动停；中间正常', () => {
    expect(decideRecord(MIN_RECORD_MS - 1)).toBe('too-short')
    expect(decideRecord(MIN_RECORD_MS)).toBe('ok')
    expect(decideRecord(MAX_RECORD_MS - 1)).toBe('ok')
    expect(decideRecord(MAX_RECORD_MS)).toBe('auto-stop')
  })
})

describe('pickTranscriptText（响应 sanitize）', () => {
  it('OpenAI 口径 text；兼容 transcript/result；纯文本兜底', () => {
    expect(pickTranscriptText('{"text":"你好"}')).toBe('你好')
    expect(pickTranscriptText('{"transcript":"hi"}')).toBe('hi')
    expect(pickTranscriptText('{"result":"ok"}')).toBe('ok')
    expect(pickTranscriptText('裸文本')).toBe('裸文本')
    expect(pickTranscriptText('{"other":1}')).toBeNull()
    expect(pickTranscriptText('   ')).toBeNull()
  })
})

describe('silentWav100ms（测试连接载荷）', () => {
  it('RIFF/WAVE 头 + 16bit 单声道 100ms', () => {
    const wav = silentWav100ms()
    const head = String.fromCharCode(...wav.slice(0, 4))
    expect(head).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(wav.length).toBe(44 + 3200) // 16kHz × 0.1s = 1600 样本 × 2 字节
  })
})

describe('buildTranscribeForm（multipart 形状）', () => {
  it('file 必带且按 mime 定扩展名；model/language 可选', () => {
    const base: Omit<TranscribeInput, 'model' | 'language'> = {
      endpoint: 'http://x/v1',
      apiKey: null,
      audio: new Uint8Array([1, 2, 3]),
      mime: 'audio/webm;codecs=opus'
    }
    const form = buildTranscribeForm({ ...base, model: 'sensevoice', language: 'zh' })
    const file = form.get('file') as File
    expect(file.name).toBe('voice.webm')
    expect(form.get('model')).toBe('sensevoice')
    expect(form.get('language')).toBe('zh')
    const auto = buildTranscribeForm({ ...base, model: '', language: 'auto' })
    expect(auto.get('model')).toBeNull()
    expect(auto.get('language')).toBeNull()
  })
})
