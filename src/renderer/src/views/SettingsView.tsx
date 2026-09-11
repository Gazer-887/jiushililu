import { useEffect, useState } from 'react'
import type { ProviderType, ReasoningEffort, SettingsSaveInput } from '@shared/ipc'
import { useAppStore } from '../store'

// 快捷档位（对标 Trae 模型面板）：点一下直接填值
const CONTEXT_PRESETS: Array<[string, number]> = [
  ['128k', 131072],
  ['256k', 262144],
  ['512k', 524288],
  ['1M', 1048576]
]
const OUTPUT_PRESETS: Array<[string, number]> = [
  ['4k', 4096],
  ['16k', 16384],
  ['32k', 32768],
  ['128k', 131072]
]

export default function SettingsView() {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [draft, setDraft] = useState<SettingsSaveInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

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

  /** 必填数字：空串按 0 处理（由 min 校验兜底） */
  const num = (v: string): number => (v === '' ? 0 : Number(v))
  /** 可留空数字：空串 = null = 不发送该参数，跟随厂商默认 */
  const nullableNum = (v: string): number | null => (v.trim() === '' ? null : Number(v))

  const reset = (): void => {
    if (!settings) return
    setDraft({ ...settings, apiKey: '' })
    setApiKey('')
    setNotice(null)
  }

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
      <button className="back-btn" onClick={() => useAppStore.getState().setView('new')}>
        ← 返回
      </button>
      <h2>编辑模型</h2>
      <p className="hint">
        全部自定义接入：不内置任何模型与 Key。Key 走系统加密存储（safeStorage），绝不落明文。
      </p>

      <label>
        接口地址 baseURL
        <input
          value={draft.baseURL}
          placeholder="如 https://api.deepseek.com（/v1 可带可不带）"
          onChange={(e) => update('baseURL', e.target.value)}
        />
      </label>

      <label>
        模型 ID（要与厂商菜单一字不差）
        <input
          value={draft.model}
          placeholder="如 deepseek-v4-flash-vision-exp"
          onChange={(e) => update('model', e.target.value)}
        />
      </label>

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
        API 密钥（{settings?.hasApiKey ? `已保存：${settings.apiKeyMasked}` : '尚未保存'}）
        <input
          type="password"
          value={apiKey}
          placeholder={settings?.hasApiKey ? '留空则保留已保存的 Key' : 'sk-...'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <button className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
        {advancedOpen ? '▾' : '▸'} 高级配置
      </button>

      {advancedOpen && (
        <div className="advanced">
          <div className="field-label">上下文窗口（Token）· 输入</div>
          <div className="with-presets">
            <input
              type="number"
              min="1024"
              max="10000000"
              step="1024"
              value={draft.contextWindow}
              onChange={(e) => update('contextWindow', num(e.target.value))}
            />
            <span className="presets">
              {CONTEXT_PRESETS.map(([label, value]) => (
                <a
                  key={label}
                  className="preset-link"
                  onClick={() => update('contextWindow', value)}
                >
                  {label}
                </a>
              ))}
            </span>
          </div>
          <p className="hint">
            模型一次能"读进"多少。客户端元数据，不发请求——历史裁剪与成本估算的依据。
          </p>

          <div className="field-label">输出上限（Token）· 单次回答</div>
          <div className="with-presets">
            <input
              type="number"
              min="1"
              max="1000000"
              value={draft.maxTokens}
              onChange={(e) => update('maxTokens', num(e.target.value))}
            />
            <span className="presets">
              {OUTPUT_PRESETS.map(([label, value]) => (
                <a
                  key={label}
                  className="preset-link"
                  onClick={() => update('maxTokens', value)}
                >
                  {label}
                </a>
              ))}
            </span>
          </div>
          <p className="hint">这次最多"说"多长。按厂商文档填——DeepSeek V4 最大 384000。</p>

          <label>
            工具调用轮数（Agent 主循环上限，防死循环烧钱）
            <input
              type="number"
              min="1"
              max="10000"
              value={draft.maxToolRounds}
              onChange={(e) => update('maxToolRounds', num(e.target.value))}
            />
          </label>

          <div className="field-label">支持图片输入</div>
          <div className="radio-row">
            <label className="radio">
              <input
                type="radio"
                name="supportsImages"
                checked={draft.supportsImages}
                onChange={() => update('supportsImages', true)}
              />
              支持
            </label>
            <label className="radio">
              <input
                type="radio"
                name="supportsImages"
                checked={!draft.supportsImages}
                onChange={() => update('supportsImages', false)}
              />
              不支持
            </label>
            <span className="hint inline-hint">多模态模型才勾（如 vision-exp），纯文本模型别勾</span>
          </div>

          <label>
            思考强度（DeepSeek low/high/max，OpenAI low/medium/high，Anthropic 折算为思考预算）
            <select
              value={draft.reasoningEffort}
              onChange={(e) => update('reasoningEffort', e.target.value as ReasoningEffort)}
            >
              <option value="default">跟随模型默认配置</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>

          <div className="field-label">采样参数（留空使用最佳配置，跟随厂商默认）</div>
          <label>
            Temperature（0 ~ 2，越高越发散）
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={draft.temperature ?? ''}
              placeholder="留空使用最佳配置"
              onChange={(e) => update('temperature', nullableNum(e.target.value))}
            />
          </label>
          <label>
            Top P（0 ~ 1，只在累计概率前 P 的词里挑）
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={draft.topP ?? ''}
              placeholder="留空使用最佳配置"
              onChange={(e) => update('topP', nullableNum(e.target.value))}
            />
          </label>
          <label>
            Top K（1 ~ 200，只在候选前 K 个词里挑）
            <input
              type="number"
              min="1"
              max="200"
              value={draft.topK ?? ''}
              placeholder="留空使用最佳配置"
              onChange={(e) => update('topK', nullableNum(e.target.value))}
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

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.stream}
              onChange={(e) => update('stream', e.target.checked)}
            />
            流式输出（推荐开启）
          </label>
        </div>
      )}

      <p className="hint">连通性测试会发起一次真实请求，消耗少量模型 Token。</p>

      <div className="actions">
        <button className="btn-secondary" onClick={reset}>
          重置
        </button>
        <button className="btn-send" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存模型'}
        </button>
        <button className="btn-secondary" disabled={testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}
