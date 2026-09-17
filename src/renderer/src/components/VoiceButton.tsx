import { useEffect, useRef, useState } from 'react'
import { decideRecord, MAX_RECORD_MS } from '@shared/voice'
import type { VoiceConfig, VoiceTranscribeResult } from '@shared/voice'

/** 选端点接受的录音格式：webm/opus 优先，逐级降级（决策 3，R4 的探测面） */
function pickMime(): string {
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (MediaRecorder.isTypeSupported(m)) return m
    }
  }
  return ''
}

/** 转写文本插到光标处（没有光标信息就追加到末尾） */
function insertAtCursor(ta: HTMLTextAreaElement | null, current: string, text: string): { next: string; caret: number } {
  const at = ta ? ta.selectionStart : current.length
  const end = ta ? ta.selectionEnd : current.length
  const head = current.slice(0, at)
  const tail = current.slice(end)
  const glue = head.length === 0 || /[\s\n]$/.test(head) ? '' : ' '
  const next = head + glue + text + tail
  return { next, caret: (head + glue + text).length }
}

interface Props {
  textareaEl: () => HTMLTextAreaElement | null
  getText: () => string
  onInsert: (next: string) => void
}

type Phase = 'idle' | 'disclosure' | 'recording' | 'transcribing' | 'error'

export default function VoiceButton({ textareaEl, getText, onInsert }: Props): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>('idle')
  const [cfg, setCfg] = useState<VoiceConfig | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [err, setErr] = useState('')
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const lastAudioRef = useRef<{ buf: ArrayBuffer; mime: string } | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function clearTimer(): void {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  async function ensureConfig(): Promise<VoiceConfig> {
    const c = await window.api.getVoiceConfig()
    setCfg(c)
    return c
  }

  async function startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream
      const mime = pickMime()
      const rec = mime.length > 0 ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        void finishRecording(rec.mimeType || 'audio/webm')
      }
      recRef.current = rec
      startedAtRef.current = performance.now()
      setSeconds(0)
      timerRef.current = window.setInterval(() => {
        const elapsed = performance.now() - startedAtRef.current
        setSeconds(Math.floor(elapsed / 1000))
        if (elapsed >= MAX_RECORD_MS) void stopRecording() // 60s 自动停（决策 2 / R7）
      }, 500)
      rec.start()
      setPhase('recording')
    } catch (e) {
      setErr(`无法开始录音：${e instanceof Error ? e.message : String(e)}`)
      setPhase('error')
    }
  }

  async function finishRecording(mime: string): Promise<void> {
    clearTimer()
    const elapsed = performance.now() - startedAtRef.current
    const decision = decideRecord(elapsed)
    if (decision === 'too-short') {
      setErr('录音太短（不足 0.5 秒），已按误触丢弃')
      setPhase('error')
      return
    }
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []
    const buf = await blob.arrayBuffer()
    lastAudioRef.current = { buf, mime }
    await sendForTranscription(buf, mime)
  }

  async function sendForTranscription(buf: ArrayBuffer, mime: string): Promise<void> {
    setPhase('transcribing')
    const r: VoiceTranscribeResult = await window.api.transcribeVoice(buf, mime)
    if (r.ok) {
      if (r.text.trim().length === 0) {
        setErr('未识别到语音')
        setPhase('error')
        return
      }
      const ta = textareaEl()
      const { next, caret } = insertAtCursor(ta, getText(), r.text.trim())
      onInsert(next)
      requestAnimationFrame(() => ta?.setSelectionRange(caret, caret))
      lastAudioRef.current = null
      setPhase('idle')
      return
    }
    setErr(r.reason)
    setPhase('error')
  }

  function stopRecording(): void {
    clearTimer()
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
  }

  async function onClick(): Promise<void> {
    if (phase === 'recording') {
      stopRecording()
      return
    }
    if (phase === 'transcribing') return
    if (phase === 'error') {
      // 错误态再点：有保留音频先重试（决策 2「不静默丢弃」），没有就重新走录音
      const keep = lastAudioRef.current
      if (keep) {
        void sendForTranscription(keep.buf, keep.mime)
        return
      }
      setPhase('idle')
    }
    const c = await ensureConfig()
    if (c.endpoint.trim().length === 0) {
      setErr('尚未配置转写端点：设置页 → 语音输入')
      setPhase('error')
      return
    }
    if (!c.disclosureAccepted) {
      setPhase('disclosure')
      return
    }
    void startRecording()
  }

  async function acceptDisclosure(): Promise<void> {
    await window.api.setVoiceConfig({ disclosureAccepted: true })
    setCfg((c) => (c ? { ...c, disclosureAccepted: true } : c))
    setPhase('idle')
    void startRecording()
  }

  const recording = phase === 'recording'
  const title = recording
    ? `录音中 ${seconds}s · 点击停止（60 秒自动停）`
    : phase === 'transcribing'
      ? '转写中…'
      : '语音输入（转写结果插入光标处）'

  return (
    <>
      <button
        type="button"
        className={`voice-btn ${recording ? 'recording' : ''}`}
        title={title}
        aria-label="语音输入"
        disabled={phase === 'transcribing'}
        onClick={() => void onClick()}
      >
        {recording ? `● ${seconds}s` : phase === 'transcribing' ? '…' : '🎤'}
      </button>
      {phase === 'error' && err.length > 0 && (
        <span className="voice-hint" onClick={() => setPhase('idle')}>
          {err}
          {lastAudioRef.current ? ' · 点击重试本段录音' : ' · 点击清除'}
        </span>
      )}
      {phase === 'disclosure' && (
        <div className="voice-disclosure-mask" onClick={() => setPhase('idle')}>
          <div className="voice-disclosure" onClick={(e) => e.stopPropagation()}>
            <h3>语音会发送到外部端点</h3>
            <p>
              你的录音将被发送到：<code>{cfg?.endpoint ?? ''}</code>
            </p>
            <p>我们不存储你的录音，也不经手转写过程 —— 它是本应用与那个端点之间的直接通信。</p>
            <p>该端点能看到你的原始录音。若使用云端服务，请确认你信任它。若端点是你本机的服务（如 127.0.0.1），则录音不会离开这台电脑。</p>
            <div className="voice-disclosure-actions">
              <button type="button" className="btn-secondary" onClick={() => setPhase('idle')}>
                取消
              </button>
              <button type="button" className="btn-secondary" onClick={() => void acceptDisclosure()}>
                我已了解，开始录音
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
