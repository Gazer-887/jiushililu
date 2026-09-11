import { useEffect, useState, type ReactNode } from 'react'
import type {
  LogsInfo,
  PermissionPreset,
  ProviderType,
  ReasoningEffort,
  SettingsSaveInput,
  WorkspaceInfo
} from '@shared/ipc'
import { useAppStore } from '../store'
import { THEMES } from '@shared/splitter'
import { PERM_HINT, PERM_LABEL } from '../components/InputTools'

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

/*
 * 设置分区导航（plan8 R7 形态改造，2026-09-12 用户意见）：
 * 形制对齐 DSH 设置页 —— 左侧分区导航 + 右侧内容，选中项为圆角胶囊高亮。
 * 图标是手写内联 SVG：只为几个图标引一个图标库不划算，且本项目维持零 UI 框架依赖。
 * 分区按**真实存在的能力**划分，不放空条目（将来 P3 生态的 MCP / 技能 / Agent 预设再加）。
 */
type SectionId = 'general' | 'model' | 'appearance' | 'trouble'

/** 权限档展示顺序：从最严到最松（与输入框工具栏同一口径） */
const PERM_ORDER: PermissionPreset[] = ['read-only', 'write', 'full-access']

const ICON_PROPS = {
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  {
    id: 'general',
    label: '通用设置',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M2.5 5.2h7.1M13.4 5.2h.1M2.5 10.8h.1M6.4 10.8h7.1" />
        <circle cx="11.4" cy="5.2" r="1.9" />
        <circle cx="4.5" cy="10.8" r="1.9" />
      </svg>
    )
  },
  {
    id: 'model',
    label: '模型',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M8 1.9 14 5.2v5.6L8 14.1 2 10.8V5.2z" />
        <path d="M2 5.2 8 8.5l6-3.3" />
        <path d="M8 8.5v5.6" />
      </svg>
    )
  },
  {
    id: 'appearance',
    label: '外观',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <circle cx="8" cy="8" r="5.8" />
        <path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" />
      </svg>
    )
  },
  {
    id: 'trouble',
    label: '故障排查',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M9.2 1.9H4.6A1.6 1.6 0 0 0 3 3.5v9a1.6 1.6 0 0 0 1.6 1.6h6.8A1.6 1.6 0 0 0 13 12.5V5.6z" />
        <path d="M9.2 1.9v3.7H13" />
        <path d="M5.5 8.6h5M5.5 11.1h3" />
      </svg>
    )
  }
]

export default function SettingsView() {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const [draft, setDraft] = useState<SettingsSaveInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  /** 设置分区：默认落在「通用设置」（最通用的一项在前，与 DSH 一致） */
  const [section, setSection] = useState<SectionId>('general')
  /** 通用设置：工作区与访问权限档 —— 都存在主进程，与输入框工具栏是同一份数据 */
  const [ws, setWs] = useState<WorkspaceInfo | null>(null)
  const [perm, setPerm] = useState<PermissionPreset>('write')
  /** 故障排查区（plan8 R2）：日志目录与最近文件，用于"出问题能查" */
  const [logs, setLogs] = useState<LogsInfo | null>(null)

  useEffect(() => {
    if (!useAppStore.getState().settingsLoaded) void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    window.api
      .getLogsInfo()
      .then(setLogs)
      .catch(() => setLogs({ dir: null, files: [] }))
  }, [])

  useEffect(() => {
    window.api
      .getWorkspace()
      .then(setWs)
      .catch(() => setWs(null))
    void window.api.getPermission().then(setPerm)
  }, [])

  useEffect(() => {
    if (settings && !draft) {
      setDraft({ ...settings, apiKey: '' })
    }
  }, [settings, draft])

  const nav = (
    <nav className="settings-nav" aria-label="设置分区">
      <div className="settings-nav-title">设置</div>
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`settings-nav-item${section === s.id ? ' is-on' : ''}`}
          aria-current={section === s.id ? 'page' : undefined}
          onClick={() => setSection(s.id)}
        >
          <span className="settings-nav-icon">{s.icon}</span>
          {s.label}
        </button>
      ))}
      <button className="back-btn" onClick={() => useAppStore.getState().setView('new')}>
        ← 返回
      </button>
    </nav>
  )

  if (!draft) {
    return (
      <div className="settings-view">
        {nav}
        <div className="settings-body">加载中…</div>
      </div>
    )
  }

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

  /** 选择工作区（走系统目录对话框，与输入框的 WorkspaceChip 同一入口） */
  const pickWs = async (): Promise<void> => {
    const next = await window.api.pickWorkspace()
    if (next) setWs(next)
  }

  const choosePerm = async (p: PermissionPreset): Promise<void> => {
    setPerm(await window.api.setPermission(p))
  }

  return (
    <div className="settings-view">
      {nav}

      <div className="settings-body">
        {section === 'general' && (
          <div className="settings-section">
            <h2>通用设置</h2>

            <div className="field-label">工作区</div>
            <p className="hint">
              Agent 读写文件的边界目录 —— 所有文件操作都被限制在此目录内，越界会被直接拒绝。
            </p>
            <div className="logs-info">
              <span className="logs-path">{ws?.path ?? '加载中…'}</span>
              {ws && !ws.custom && <span className="logs-count">内置默认</span>}
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={() => void pickWs()}>
                选择目录…
              </button>
              <button
                className="btn-secondary"
                disabled={!ws}
                onClick={() => ws && void window.api.revealWorkspace(ws.path)}
              >
                打开目录
              </button>
            </div>

            <div className="field-label">访问权限</div>
            <p className="hint">
              能力归模型，权限归人 —— 这是唯一由你决定的档位。与输入框工具栏那处是同一个设置，
              改哪边都生效。
            </p>
            <div className="choice-list choice-list-fill" role="radiogroup" aria-label="访问权限">
              {PERM_ORDER.map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={perm === p}
                  className={`choice-item${perm === p ? ' is-on' : ''}`}
                  onClick={() => void choosePerm(p)}
                >
                  <span className="choice-name">{PERM_LABEL[p]}</span>
                  <span className="choice-desc">{PERM_HINT[p]}</span>
                </button>
              ))}
            </div>

            <div className="field-label">界面布局</div>
            <p className="hint">左右抽屉的宽度可在分隔处拖动调整，双击分隔条即可复位。</p>
            <div className="actions">
              <button
                className="btn-secondary"
                onClick={() => void useAppStore.getState().resetUIPrefs()}
              >
                恢复默认布局
              </button>
            </div>
          </div>
        )}

        {section === 'model' && (
          <>
            <h2>模型</h2>
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
                  <span className="hint inline-hint">
                    多模态模型才勾（如 vision-exp），纯文本模型别勾
                  </span>
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
          </>
        )}

        {section === 'appearance' && (
          /* plan7 外观自定义：主题切换（水墨 / 经典），切换即时生效并持久化 */
          <div className="settings-section">
            <h2>外观</h2>
            <p className="hint">切换立即生效，重启后保持。</p>
            <div className="choice-list" role="radiogroup" aria-label="主题">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={theme === t.id}
                  className={`choice-item${theme === t.id ? ' is-on' : ''}`}
                  onClick={() => setTheme(t.id)}
                >
                  <span className="choice-name">{t.label}</span>
                  <span className="choice-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {section === 'trouble' && (
          /* plan8 R2：故障排查入口。出问题时用户能一键找到日志，而不是只看到"出错了" */
          <div className="settings-section">
            <h2>故障排查</h2>
            <p className="hint">
              运行日志会自动记录在本地（已过滤 API Key 等敏感信息，不会明文落盘）。
              遇到异常时，把最近的日志文件发给开发者即可定位。
            </p>
            <div className="logs-info">
              <span className="logs-path">
                {logs?.dir ?? '（日志目录尚未创建，产生首条日志后自动出现）'}
              </span>
              {logs && logs.files.length > 0 && (
                <span className="logs-count">最近 {logs.files.length} 个文件</span>
              )}
            </div>
            <div className="actions">
              <button
                className="btn-secondary"
                disabled={!logs?.dir}
                onClick={() => void window.api.openLogsDir()}
              >
                打开日志文件夹
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
