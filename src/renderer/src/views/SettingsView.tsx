import { useEffect, useState, type ReactNode } from 'react'
import type {
  LogsInfo,
  PermissionPreset,
  ProviderType,
  SettingsSaveInput,
  WorkspaceInfo
} from '@shared/ipc'
import { sourceLabel, type ModelEntry, type ModelProfileView, type ModelsView } from '@shared/models'
import ModelCatalogEditor from '../components/ModelCatalogEditor'
import { useAppStore } from '../store'
import { THEMES } from '@shared/splitter'
import { PERM_HINT, PERM_LABEL } from '../components/InputTools'
import { TOKEN_TIER_LIST, type TokenSaverTier } from '@shared/token-tier'

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

// 模型行的图标（plan7 F5）：**内联 SVG 手绘，不用 emoji** ——
// 与项目其它图标同一口径（emoji 会随系统字体变样，也压不住水墨那套黑白灰）。
// 语义：鲸鱼 = DeepSeek 官方来源；菱形闪光 = 用户自定义；其余是操作图标。
function IconWhale(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M2 6.5c0-1.4 1.1-2.5 2.5-2.5h5C11 4 12 5 12 6.5V8c0 2.2-1.8 4-4 4H5.5A3.5 3.5 0 0 1 2 8.5z"
        fill="currentColor"
      />
      <circle cx="5.4" cy="7" r="0.9" fill="var(--panel)" />
      <path d="M12 6.2c1.4-.6 2.6-.2 2.6 1.3 0 1.6-1.4 2-2.6 1.4z" fill="currentColor" />
    </svg>
  )
}

function IconSpark(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 1.6 9.5 6 14 7.5 9.5 9 8 13.4 6.5 9 2 7.5 6.5 6z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function IconPencil(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M11.2 2.3l2.5 2.5-8 8-3.2.7.7-3.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function IconLink(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M6.5 9.5 9.5 6.5M6 11.5l-1 1a2.4 2.4 0 0 1-3.4-3.4l2-2a2.4 2.4 0 0 1 3-.3M10 4.5l1-1a2.4 2.4 0 0 1 3.4 3.4l-2 2a2.4 2.4 0 0 1-3 .3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconTrash(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

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
  /** 设置分区：默认落在「通用设置」（最通用的一项在前，与 DSH 一致） */
  const [section, setSection] = useState<SectionId>('general')
  /** 通用设置：工作区与访问权限档 —— 都存在主进程，与输入框工具栏是同一份数据 */
  const [ws, setWs] = useState<WorkspaceInfo | null>(null)
  const [perm, setPerm] = useState<PermissionPreset>('write')
  /** 省 token 档位（plan8 R9.1 §七②）：跟权限档一样是"人定的档"，真值在主进程 */
  const [tier, setTier] = useState<TokenSaverTier>('balanced')
  /** 故障排查区（plan8 R2）：日志目录与最近文件，用于"出问题能查" */
  const [logs, setLogs] = useState<LogsInfo | null>(null)

  // ── 多模型管理（plan7 F5）──
  /** 模型列表（含"当前用哪个"与 models.json 的真实路径，都由主进程给真值） */
  const [models, setModels] = useState<ModelsView | null>(null)
  /** 正在编辑哪一条；`null` = 只看列表。`{id: undefined}` = 新增 */
  const [editingModel, setEditingModel] = useState<{ id?: string } | null>(null)
  /** 编辑中的显示名（与"模型 ID"是两件事：前者给人看，后者给厂商看） */
  const [draftName, setDraftName] = useState('')
  /** 编辑中的**模型目录**（F5.1）：一行一个模型，各自带可选的高级设置 */
  const [draftModels, setDraftModels] = useState<ModelEntry[]>([])
  /** 哪一条在测连接（按钮显示"测试中"） */
  const [modelBusy, setModelBusy] = useState<string | null>(null)
  const [modelNotice, setModelNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const refreshModels = async (): Promise<void> => {
    try {
      setModels(await window.api.listModels())
    } catch {
      setModels(null)
    }
  }

  useEffect(() => {
    void refreshModels()
  }, [])

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
    void window.api.getTokenTier().then(setTier)
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

  const reset = (): void => {
    if (!settings) return
    setDraft({ ...settings, apiKey: '' })
    setApiKey('')
    setNotice(null)
  }
  void reset // 多模型之后「重置」被「取消」取代（重置成当前模型没有意义 —— 表单只在编辑时出现）

  /**
   * 保存。
   *
   * 多模型之后，"保存"写的是**这一条档案**（新增则创建），不是"全局那一份设置"——
   * 它是用户此刻在编辑的那个模型，语义上必须是"存进这一条"。
   */
  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setNotice(null)
    try {
      if (editingModel) {
        const saved = await window.api.saveModel({
          ...(editingModel.id ? { id: editingModel.id } : {}),
          name: draftName,
          providerType: draft.providerType,
          baseURL: draft.baseURL,
          timeoutMs: draft.timeoutMs,
          stream: draft.stream,
          models: draftModels,
          apiKey
        })
        await refreshModels()
        await loadSettings()
        setDraftName(saved.name)
        setDraftModels(saved.models)
        setEditingModel({ id: saved.id })
        setApiKey('')
        setNotice({ ok: true, text: apiKey ? '已保存（Key 已加密入库）' : '已保存' })
        return
      }
      // 理论到不了这儿（表单只在编辑时出现）；留着是为了万一有别的入口
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
      // 编辑既有模型 → 测**它自己**（用它已存的 Key，不必重新填）
      // 新增中 → 用表单里的值现测（还没入库，没有档案可测）
      const result = editingModel?.id
        ? await window.api.testModel(editingModel.id)
        : await window.api.testConnection({ ...draft, apiKey })
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

  /** 选省 token 档位（plan8 R9.1 §七②）。**全局一档** —— 不做会话级覆盖（用户定调） */
  const chooseTier = async (next: TokenSaverTier): Promise<void> => {
    setTier(await window.api.setTokenTier(next))
  }

  // ── 多模型：增删改与"改用这个"（plan7 F5）──
  //
  // 三条纪律：
  //   ① **删除先确认**（红线）：确认框里说清它叫什么
  //   ② **至少要留一个** —— 护栏在主进程，这里只把它的理由原样显示
  //   ③ 每次改动都 `refreshModels()` 重新拉真值，而不是在本地猜一份（列表就是真值）

  /** 新增端点：连接信息沿用当前设置当模板；**模型目录从空的一条起步** */
  const startCreate = (): void => {
    if (!settings) return
    setDraft({ ...settings, apiKey: '' })
    setDraftName('')
    setDraftModels([{ id: `m-${Date.now().toString(36)}`, model: '' }])
    setApiKey('')
    setNotice(null)
    setModelNotice(null)
    setEditingModel({})
  }

  /** 编辑端点：连接信息进表单，**整份模型目录进编辑器**（一行一个模型，各自带高级设置） */
  const startEdit = (p: ModelProfileView): void => {
    // 表单只负责**连接级**四项（协议 / 地址 / 超时 / 流式）——
    // 采样、输出上限、上下文窗口那些"模型级"参数归目录里每个模型自己的高级设置（F5.1）
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            providerType: p.providerType,
            baseURL: p.baseURL,
            timeoutMs: p.timeoutMs,
            stream: p.stream,
            apiKey: ''
          }
        : prev
    )
    setDraftName(p.name)
    setDraftModels(p.models.map((m) => ({ ...m, ...(m.settings ? { settings: { ...m.settings } } : {}) })))
    setApiKey('')
    setNotice(null)
    setModelNotice(null)
    setEditingModel({ id: p.id })
  }

  const cancelEdit = (): void => {
    setEditingModel(null)
    setApiKey('')
    setNotice(null)
    if (settings) setDraft({ ...settings, apiKey: '' })
  }

  const useProfile = async (id: string): Promise<void> => {
    setModelNotice(null)
    try {
      setModels(await window.api.setActiveModel(id))
      // 当前模型变了 → 设置页与输入框读的都是"当前档案"，拉一次保持一致
      await loadSettings()
    } catch (err) {
      setModelNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }

  const testProfile = async (id: string): Promise<void> => {
    setModelBusy(id)
    setModelNotice(null)
    try {
      const result = await window.api.testModel(id)
      const tail = result.latencyMs != null ? `（${result.latencyMs}ms）` : ''
      setModelNotice({ ok: result.ok, text: result.message + tail })
    } catch (err) {
      setModelNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setModelBusy(null)
    }
  }

  const removeProfileById = async (id: string): Promise<void> => {
    const target = models?.profiles.find((p) => p.id === id)
    // 红线：删除先问。这里用系统确认框 —— 与文件删除同一套"问一句"的纪律
    if (!window.confirm(`删除模型「${target?.name ?? id}」？\n\n它的 API Key 会一起删掉（工作区文件不受影响）。`)) {
      return
    }
    setModelNotice(null)
    try {
      await window.api.deleteModel(id)
      await refreshModels()
      await loadSettings()
      setModelNotice({ ok: true, text: '已删除' })
    } catch (err) {
      // 护栏（至少要留一个）会从主进程抛出**人话**理由，原样显示
      setModelNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="settings-view">
      {nav}

      <div className="settings-body">
        {section === 'general' && (
          <div className="settings-section">
            <h2>通用设置</h2>

            <div className="field-label">工作区</div>
            <p className="hint">Agent 只能读写这个目录里的文件，越界会被拒绝。</p>
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
            {/* 只留"这句在哪还能改"这一半：前半句是产品口号，每页来一次就成了噪音 */}
            <p className="hint">与输入框工具栏那处是同一个设置，改哪边都生效。</p>
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

            <div className="field-label">省 token 档位</div>
            {/* 用户定调（plan8 R9.1 §七②）：**省 token 不许让模型降智**，
                所以"能力 vs 省钱"这个取舍摆出来让人选，不替他默认一个激进值 */}
            <p className="hint">
              只影响省 token 的手段（工具输出的压缩力度、读文件默认给多少行），
              不会因为选了省档就改数字或藏起厂商没报的东西。
            </p>
            <div className="choice-list choice-list-fill" role="radiogroup" aria-label="省 token 档位">
              {TOKEN_TIER_LIST.map((t) => (
                <button
                  key={t.tier}
                  role="radio"
                  aria-checked={tier === t.tier}
                  className={`choice-item${tier === t.tier ? ' is-on' : ''}`}
                  onClick={() => void chooseTier(t.tier)}
                >
                  <span className="choice-name">{t.label}</span>
                  <span className="choice-desc">{t.note}</span>
                </button>
              ))}
            </div>

            <div className="field-label">界面布局</div>
            {/* 原来那句在教"怎么拖分隔条"——可拖动是直觉操作，双击复位属于彩蛋，
                不值得占一行浅字；这个标题下真正要给的只有那个按钮 */}
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

            {/* ── 模型列表（plan7 F5 多模型管理）──────────────────────────────
                形态照用户给的那张：标题 + "会自动写进本地 …models.json" + [添加模型]，
                下面是 图标 / 名字 / 来源 / 三个操作（编辑 · 测试连接 · 删除）。
                为什么要有"当前用哪个"：列表没有当前态就是一坨——用户看不出正在用谁。
                （路径来自主进程的真值，不硬编码 —— 说得出口就得是真的） */}
            <div className="model-head">
              <div className="model-head-text">
                <div className="model-head-title">自定义模型</div>
                <p className="hint">
                  模型添加后会自动写入到本地 <code className="model-file">{models?.filePath ?? '…'}</code> 文件
                </p>
              </div>
              <button className="btn-secondary model-add" onClick={startCreate}>
                添加模型
              </button>
            </div>

            {models && models.profiles.length === 0 && (
              <p className="hint">还没有模型。点右上「添加模型」填一个 —— 填完就能开始对话。</p>
            )}

            {models && models.profiles.length > 0 && (
              <div className="model-list">
                {models.profiles.map((p) => (
                  <div key={p.id} className={`model-row ${p.id === models.activeId ? 'on' : ''}`}>
                    <span className="model-mark" aria-hidden>
                      {p.source === 'deepseek' ? <IconWhale /> : <IconSpark />}
                    </span>
                    <span className="model-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="model-source">{sourceLabel(p.source)}</span>
                    {p.id === models.activeId && <span className="model-current">当前</span>}
                    <span className="model-actions">
                      <button className="model-act" title="编辑这个模型" onClick={() => startEdit(p)}>
                        <IconPencil />
                      </button>
                      <button
                        className="model-act"
                        title={p.hasApiKey ? '测试连接（用它自己的 Key）' : '还没有填 API Key'}
                        disabled={modelBusy === p.id}
                        onClick={() => void testProfile(p.id)}
                      >
                        <IconLink />
                      </button>
                      <button className="model-act model-act-del" title="删除这个模型" onClick={() => void removeProfileById(p.id)}>
                        <IconTrash />
                      </button>
                      {p.id !== models.activeId && (
                        <button
                          className="model-act model-act-use"
                          title="改用这个模型"
                          onClick={() => void useProfile(p.id)}
                        >
                          改用
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {modelNotice && (
              <div className={modelNotice.ok ? 'notice-ok' : 'notice-err'}>{modelNotice.text}</div>
            )}

            {/* ── 编辑表单：只在新增 / 编辑时出现（列表演示时不该占着半屏）── */}
            {editingModel && (
              <>
                <div className="model-form-title">{editingModel.id ? '编辑模型' : '添加模型'}</div>

                <label>
                  显示名称（列表里显示这个）
                  <input
                    value={draftName}
                    placeholder="如 DeepSeek-V4 Flash"
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </label>

                <p className="hint">Key 走系统加密存储（safeStorage），不落明文。</p>

                <label>
                  接口地址 baseURL
                  <input
                    value={draft.baseURL}
                    placeholder="如 https://api.deepseek.com（/v1 可带可不带）"
                    onChange={(e) => update('baseURL', e.target.value)}
                  />
                </label>
                {/* **模型目录**（plan7 F5.1）：一把 Key 能调的模型都放这儿，
                    每个模型还能各自展开高级设置 —— 形态照用户给的那张配置页截图 */}
                <ModelCatalogEditor
                  models={draftModels}
                  onChange={setDraftModels}
                  onFetch={async () => {
                    if (!editingModel?.id) {
                      return { ok: false, message: '先保存这个端点（填好地址与 Key），再来拉取模型列表', models: [] }
                    }
                    return window.api.listAvailableModels(editingModel.id)
                  }}
                />

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


            {/* 这句承重（会花钱，得先说）—— 只把主语去掉，不删 */}
            <p className="hint">会发起一次真实请求，消耗少量 Token。</p>

            <div className="actions">
              <button className="btn-secondary" onClick={cancelEdit}>
                取消
              </button>
              <button className="btn-send" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : editingModel?.id ? '保存修改' : '保存模型'}
              </button>
              <button className="btn-secondary" disabled={testing} onClick={() => void test()}>
                {testing ? '测试中…' : '测试连接'}
              </button>
            </div>

                {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
              </>
            )}
          </>
        )}

        {section === 'appearance' && (
          /* plan7 外观自定义：主题切换（水墨 / 经典），切换即时生效并持久化 */
          <div className="settings-section">
            <h2>外观</h2>
            {/* 原来那句"切换立即生效，重启后保持"是**一切设置**的共性 —— 说了等于没说 */}
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
            {/* 承重（隐私 + 怎么用），但一句话说得完 —— 原来两行里有半行是重复的 */}
            <p className="hint">日志记在本地，已过滤 API Key 等敏感信息；报障时把最近的日志发出来即可。</p>
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