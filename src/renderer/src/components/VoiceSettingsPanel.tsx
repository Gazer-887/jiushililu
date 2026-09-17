import { useEffect, useState } from 'react'
import type { VoiceConfig, VoiceTranscribeResult } from '@shared/voice'

/**
 * 语音输入设置区（plan45 决策 1/5）：端点自配 + 推荐服务清单，只说明不代劳。
 * Key 只进不出：输入框留空 = 不动已存；清除走显式按钮。
 */
export default function VoiceSettingsPanel(): React.ReactElement {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [language, setLanguage] = useState<'auto' | 'zh' | 'en'>('auto')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [noteKind, setNoteKind] = useState<'ok' | 'err'>('ok')

  async function reload(): Promise<VoiceConfig> {
    const c = await window.api.getVoiceConfig()
    setCfg(c)
    setEndpoint(c.endpoint)
    setModel(c.model)
    setLanguage(c.language)
    return c
  }
  useEffect(() => {
    void reload()
  }, [])

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const c = await window.api.setVoiceConfig({
        endpoint,
        model,
        language,
        ...(apiKeyDraft.length > 0 ? { apiKey: apiKeyDraft } : {})
      })
      setCfg(c)
      setApiKeyDraft('')
      setNoteKind('ok')
      setNote('已保存')
    } catch (e) {
      setNoteKind('err')
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    const r: VoiceTranscribeResult = await window.api.testVoiceEndpoint()
    setNoteKind(r.ok ? 'ok' : 'err')
    setNote(r.ok ? r.text : r.reason)
    setBusy(false)
  }

  return (
    <div className="settings-section voice-panel">
      <h2>语音输入</h2>
      <p className="hint">
        转写由 OpenAI 兼容端点完成（`POST /v1/audio/transcriptions`）；标点与分段由端点决定，本应用不做任何后处理。
      </p>

      <label className="voice-field">
        <span>端点 URL</span>
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://127.0.0.1:7101/v1" />
        <small>例：本机 FunASR / SenseVoice、云端 Whisper 兼容接口、内网自建服务</small>
      </label>
      <label className="voice-field">
        <span>API Key</span>
        <input
          type="password"
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          placeholder={cfg?.hasApiKey ? '已保存（留空则不改动）' : '本地端点通常可留空'}
        />
        {cfg?.hasApiKey && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void window.api.setVoiceConfig({ apiKey: null }).then((c) => {
                setCfg(c)
                setNoteKind('ok')
                setNote('已清除 Key')
              })
            }
          >
            清除已存 Key
          </button>
        )}
      </label>
      <label className="voice-field">
        <span>模型名（可选）</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空 = 端点默认模型" />
      </label>
      <label className="voice-field">
        <span>语言</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value as 'auto' | 'zh' | 'en')}>
          <option value="auto">自动（判定归端点）</option>
          <option value="zh">中文</option>
          <option value="en">英文</option>
        </select>
      </label>

      <div className="actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button type="button" className="btn-secondary" disabled={busy || (cfg?.endpoint ?? '').length === 0} onClick={() => void test()}>
          测试连接
        </button>
        {cfg && !cfg.disclosureAccepted && <span className="voice-tag">首次录音时展示隐私披露</span>}
        {cfg && cfg.disclosureAccepted && (
          <button type="button" className="btn-secondary" onClick={() => void window.api.setVoiceConfig({ disclosureAccepted: false }).then(reload)}>
            重看隐私披露
          </button>
        )}
      </div>
      {note.length > 0 && <p className={`hint voice-note ${noteKind}`}>{note}</p>}

      <details className="voice-guide">
        <summary>可选服务（只说明，不代装）</summary>
        <ul>
          <li><b>本机自建</b>：FunASR / SenseVoice / whisper.cpp —— 隐私最好、零成本，需自己部署。端点未启用标点模型时，转写结果可能无标点。</li>
          <li><b>云端 OpenAI 兼容</b>：各厂商 Whisper 兼容接口 —— 开箱可用、按量计费，需自己注册拿 Key。</li>
          <li><b>内网自建</b>：公司部署的转写服务 —— 合规可控。</li>
        </ul>
        <p>本应用不预置任何服务地址与密钥，也不代为注册或安装。</p>
      </details>
    </div>
  )
}
