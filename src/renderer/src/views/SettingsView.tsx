import { useEffect, useState } from 'react'
import type { ProviderType, SettingsSaveInput } from '@shared/ipc'
import { useAppStore } from '../store'

export default function SettingsView() {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [draft, setDraft] = useState<SettingsSaveInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!useAppStore.getState().settingsLoaded) void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    if (settings && !draft) {
      setDraft({ ...settings, apiKey: '' })
    }
  }, [settings, draft])

  if (!draft) return <div className="settings-view">加载中…</div>

  const update = <K extends keyof SettingsSaveInput>(key: K, value: SettingsSaveInput[K]): void => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
  }

  const num = (v: string): number => (v === '' ? 0 : Number(v))

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setNotice(null)
    try {
      const view = await window.api.saveSettings({ ...draft, apiKey })
      useAppStore.setState({ settings: view })
      setApiKey('')
      setNotice({ ok: true, text: apiKey ? '已保存（Key 已加密入库）' : '已保存' })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!draft) return
    setTesting(true)
    setNotice(null)
    try {
      const result = await window.api.testConnection({ ...draft, apiKey })
      const tail = result.latencyMs != null ? `（${result.latencyMs}ms）` : ''
      setNotice({ ok: result.ok, text: result.message + tail })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-view">
      <h2>模型设置</h2>
      <p className="hint">
        全部自定义接入：不内置任何模型与 Key。Key 走系统加密存储（safeStorage），绝不落明文。
      </p>

      <label>
        协议类型
        <select
          value={draft.providerType}
          onChange={(e) => update('providerType', e.target.value as ProviderType)}
        >
          <option value="openai-compatible">
            OpenAI 兼容（DeepSeek / 通义 / 智谱 / Ollama / vLLM 等）
          </option>
          <option value="anthropic">Anthropic 原生</option>
        </select>
      </label>

      <label>
        接口地址 baseURL
        <input
          value={draft.baseURL}
          placeholder="如 https://api.deepseek.com（/v1 可带可不带）"
          onChange={(e) => update('baseURL', e.target.value)}
        />
      </label>

      <label>
        模型名
        <input
          value={draft.model}
          placeholder="如 deepseek-chat（要与厂商菜单一字不差）"
          onChange={(e) => update('model', e.target.value)}
        />
      </label>

      <label>
        API Key（{settings?.hasApiKey ? `已保存：${settings.apiKeyMasked}` : '尚未保存'}）
        <input
          type="password"
          value={apiKey}
          placeholder={settings?.hasApiKey ? '留空则保留已保存的 Key' : 'sk-...'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <div className="row">
        <label>
          temperature（0~2）
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={draft.temperature}
            onChange={(e) => update('temperature', num(e.target.value))}
          />
        </label>
        <label>
          max_tokens（单次回答上限，常用 1024~8192，最大 200000）
          <input
            type="number"
            min="1"
            max="200000"
            value={draft.maxTokens}
            onChange={(e) => update('maxTokens', num(e.target.value))}
          />
        </label>
        <label>
          超时（毫秒）
          <input
            type="number"
            min="1000"
            step="1000"
            value={draft.timeoutMs}
            onChange={(e) => update('timeoutMs', num(e.target.value))}
          />
        </label>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.stream}
          onChange={(e) => update('stream', e.target.checked)}
        />
        流式输出（推荐开启）
      </label>

      <div className="actions">
        <button className="btn-send" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn-secondary" disabled={testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}
