import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type {
  LogsInfo,
  PermissionPreset,
  ProviderType,
  SettingsSaveInput,
  StorageLocationInfo,
  TestResult,
  WorkspaceInfo
} from '@shared/ipc'
import { entryLabel, sourceLabel, type ModelEntry, type ModelProfileView, type ModelsView } from '@shared/models'
import ModelCatalogEditor from '../components/ModelCatalogEditor'
import AgentManager from '../components/AgentManager'
import VoiceSettingsPanel from '../components/VoiceSettingsPanel'
import DevEnvSettings from '../components/DevEnvSettings'
import ComputerUseRecommend from '../components/ComputerUseRecommend'
import SkillsPanel from '../components/SkillsPanel'
import McpPanel from '../components/McpPanel'
import MemorySettings from '../components/MemorySettings'
import FieldNote from '../components/FieldNote'
import { useAppStore } from '../store'
import { THEMES, FONT_SCALES } from '@shared/splitter'
import type { SystemFontsResult } from '@shared/font-names'
import { PERM_HINT, PERM_LABEL } from '../components/InputTools'
import { TOKEN_TIER_LIST, type TokenSaverTier } from '@shared/token-tier'
import { SYSTEM_TOGGLES, type SystemSettings, type SystemView } from '@shared/system'
import {
  PROXY_MODES,
  PROXY_PROBE_URL,
  describeProxy,
  type NetworkPatch,
  type NetworkView
} from '@shared/network'

/*
 * 设置分区导航（plan8 R7）：形制对齐 DSH 设置页 —— 左侧分区导航 + 右侧内容，选中项为圆角胶囊高亮。
 * 图标是手写内联 SVG：为几个图标引一个图标库不划算，且本项目维持零 UI 框架依赖。
 * 分区按**真实存在的能力**划分，不放空条目（P3 生态的 MCP / 技能届时再加；子 Agent 已随 plan17 落地）。
 */
type SectionId = 'general' | 'model' | 'voice' | 'dev-env' | 'agents' | 'skills' | 'mcp' | 'memory' | 'appearance' | 'trouble'

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
    id: 'voice',
    label: '语音输入',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <rect x="6.2" y="2" width="3.6" height="7" rx="1.8" />
        <path d="M4 8a4 4 0 0 0 8 0M8 12v2.2" />
      </svg>
    )
  },
  {
    id: 'dev-env',
    label: '开发环境',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M6.2 4.6 3 8l3.2 3.4M9.8 4.6 13 8l-3.2 3.4" />
      </svg>
    )
  },
  {
    id: 'agents',
    label: '子 Agent',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <circle cx="5.2" cy="4.4" r="2.4" />
        <circle cx="11.6" cy="11.2" r="2.4" />
        <path d="M7.6 5.9 9.5 9.4" />
      </svg>
    )
  },
  {
    id: 'skills',
    label: '技能',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M3 3.5h7.2L13 6.3v6.2a1.3 1.3 0 0 1-1.3 1.3H3z" />
        <path d="M5.6 6.4h4.8M5.6 9h4.8" />
      </svg>
    )
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <circle cx="4.4" cy="8" r="2.4" />
        <circle cx="11.6" cy="8" r="2.4" />
        <path d="M6.8 8h2.4" />
      </svg>
    )
  },
  {
    id: 'memory',
    label: '记忆',
    icon: (
      <svg {...ICON_PROPS} aria-hidden="true">
        <path d="M8 2.2a3.4 3.4 0 0 1 3.4 3.4v4.8a3.4 3.4 0 0 1-6.8 0V5.6A3.4 3.4 0 0 1 8 2.2z" />
        <path d="M5.5 8.6h5" />
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

// 模型行图标**内联 SVG 手绘、不用 emoji**（emoji 会随系统字体变样，也压不住水墨那套黑白灰）。
// 语义：鲸鱼 = DeepSeek 官方来源；菱形闪光 = 用户自定义。
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

/** ⚠️ `onClose` 已弃用但**保留签名**：设置改成独立窗口后，出口是窗口外壳右上角的 ×（见 SettingsWindow），
 *  视图自己不再需要"返回"回调。留着参数是为了不打断既有调用点（传了也不生效，故加下划线前缀）。 */
export default function SettingsView({ onClose: _onClose }: { onClose?: () => void } = {}) {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  // ── 字号 / 字体（plan7 批 F3）：值在 store（文档级属性，改了即时生效）──
  const fontScale = useAppStore((s) => s.fontScale)
  const setFontScale = useAppStore((s) => s.setFontScale)
  const uiFont = useAppStore((s) => s.uiFont)
  const setUiFont = useAppStore((s) => s.setUiFont)
  const [draft, setDraft] = useState<SettingsSaveInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 默认落在「通用设置」（最通用的一项在前，与 DSH 一致） */
  const [section, setSection] = useState<SectionId>('general')
  /** 工作区与权限档都存在主进程，与输入框工具栏是同一份数据 */
  const [ws, setWs] = useState<WorkspaceInfo | null>(null)
  /** 存储位置（plan10 C 批）：应用数据落点，真值在主进程（含待生效迁移与最近一次迁移结果） */
  const [storage, setStorage] = useState<StorageLocationInfo | null>(null)
  const [perm, setPerm] = useState<PermissionPreset>('write')
  /** 电脑控制开关（2026-09-15）：真值在主进程；当前无对应工具，先落门控（状态进自视段） */
  const [ccEnabled, setCcEnabled] = useState<boolean | null>(null)
  /** 省 token 档位：跟权限档一样是"人定的档"，真值在主进程 */
  const [tier, setTier] = useState<TokenSaverTier>('balanced')
  /** 系统集成（plan7 批 F1）：值与**真生效状态**都在主进程（blocker 起没起来只有它知道） */
  const [sys, setSys] = useState<SystemView | null>(null)
  /** 网络代理（plan7 批 F2）：**当前生效的是谁**只有主进程探测得到，界面不猜 */
  const [net, setNet] = useState<NetworkView | null>(null)
  /** 手动档的三项输入。⚠️ 凭据**不回显**（与主进程同口径）：只报「已保存」，改就重新填 */
  const [netRules, setNetRules] = useState('')
  const [netUser, setNetUser] = useState('')
  const [netPass, setNetPass] = useState('')
  /** Firecrawl（plan32）：web_search 密钥型源。Key **不回显**（与代理凭据同口径）：读回只有"已配置/未配置" */
  const [fcHas, setFcHas] = useState(false)
  const [fcInput, setFcInput] = useState('')
  const [fcError, setFcError] = useState<string | null>(null)
  /** 系统字体列表（plan7 批 F3）：进「外观」分区时向主进程要，列不出就显示原因 */
  const [fonts, setFonts] = useState<SystemFontsResult | null>(null)
  /** 故障排查区：日志目录与最近文件，用于"出问题能查" */
  const [logs, setLogs] = useState<LogsInfo | null>(null)

  // ── 多模型管理（plan7 F5）──
  /** 模型列表（含"当前用哪个"与 models.json 的真实路径，真值都由主进程给） */
  const [models, setModels] = useState<ModelsView | null>(null)
  /** 正在编辑哪一条；`null` = 只看列表。`{id: undefined}` = 新增 */
  const [editingModel, setEditingModel] = useState<{ id?: string } | null>(null)
  /** 编辑中的显示名（与"模型 ID"是两件事：前者给人看，后者给厂商看） */
  const [draftName, setDraftName] = useState('')
  /** 编辑中的**模型目录**（F5.1）：一行一个模型，各自带可选的高级设置 */
  const [draftModels, setDraftModels] = useState<ModelEntry[]>([])
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
    void window.api.getComputerControl().then(setCcEnabled)
    void window.api.getTokenTier().then(setTier)
    void window.api
      .getStorageLocation()
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [])

  // 系统集成（plan7 批 F1）：进「通用设置」时取一次真值。依赖 section 而不是空数组，
  // 是为了"切走再回来"能重取 —— 系统状态可能被应用之外的东西改（用户在系统的启动项里关掉自启）
  useEffect(() => {
    if (section !== 'general') return
    void window.api
      .getSystem()
      .then(setSys)
      .catch(() => setSys(null))
  }, [section])

  // 网络代理（plan7 批 F2）：与系统集成同理，进「通用设置」时重取 ——
  // 「当前生效的代理」会被系统设置、网络切换、PAC 脚本改变，缓存久了就是错的。
  useEffect(() => {
    if (section !== 'general') return
    void window.api
      .getNetwork()
      .then((v) => {
        setNet(v)
        setNetRules(v.proxyRules)
      })
      .catch(() => setNet(null))
    void window.api
      .getFirecrawl()
      .then((r) => setFcHas(r.hasKey))
      .catch(() => setFcHas(false))
  }, [section])
  useEffect(() => {
    if (section !== 'appearance') return
    // 字体枚举失败**不是错误**：显示原因、退化为手动输入框，设置页照常工作
    window.api
      .listFonts()
      .then(setFonts)
      .catch(() => setFonts({ ok: false, fonts: [], message: '字体列表获取失败，可手动输入字体名。' }))
  }, [section])

  /**
   * 一律用主进程返回值回显：`applied` 与 `effective` 只有它给得出，乐观更新就是「假绿」。
   *
   * ⚠️ 每次都把**界面当前显示的档位**一起发（`proxyMode: net?.proxyMode`）—— 门禁抓出来的真 bug：
   *   只发 `{proxyRules}` 的话，主进程会拿「上次落盘的档位」顶替。典型翻车链：切到「手动配置」
   *   （还没填地址 → 体检不通过 → 档位**没有落盘**）→ 填好地址点「应用」→ 主进程按旧档位存 ——
   *   用户明明在手动配置里填的地址，存完却变回「跟随系统」，而且界面不报错。
   */
  const applyNetwork = async (patch: NetworkPatch): Promise<void> => {
    const merged: NetworkPatch = { proxyMode: net?.proxyMode, ...patch }
    try {
      const v = await window.api.setNetwork(merged)
      setNet(v)
      setNetRules(v.proxyRules)
      // 凭据保存成功就清空输入框：不回显明文，也不让用户以为「还在编辑上次那串」
      if (merged.proxyUser !== undefined || merged.proxyPass !== undefined) {
        setNetUser('')
        setNetPass('')
      }
    } catch {
      void window.api
        .getNetwork()
        .then(setNet)
        .catch(() => setNet(null))
    }
  }

  /** Firecrawl（plan32）：保存/清除后用主进程返回值回显，输入框清空（不回显明文）。报错原样展示 */
  const applyFirecrawl = async (key: string | null): Promise<void> => {
    setFcError(null)
    try {
      const r = await window.api.setFirecrawl(key)
      setFcHas(r.hasKey)
      setFcInput('')
    } catch (err) {
      setFcError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseSystem = async (key: keyof SystemSettings, value: boolean): Promise<void> => {
    const patch: Partial<SystemSettings> =
      key === 'keepRunning' ? { keepRunning: value } : { openAtLogin: value }
    try {
      // 用主进程返回值回显，不做乐观更新：真值可能是"没生效"（blocker 起不来 / 启动项被系统拒绝）
      setSys(await window.api.setSystem(patch))
    } catch {
      void window.api
        .getSystem()
        .then(setSys)
        .catch(() => setSys(null))
    }
  }

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
      {/* ⚠️ 这里**不再有「← 返回」**（2026-09-13 设置改独立窗口）：返回按钮是"在主区域里从设置退回对话"
          那个形态的产物。设置现在是个**独立窗口**，出口是窗口右上角的关闭按钮（见 SettingsWindow）。
          留一个「返回」会变成"返回哪儿？"的死按钮 —— 与 plan8 R5 的死代码同性质，故一并删掉。 */}
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
  void reset // 多模型之后「重置」被「取消」取代 —— 表单只在编辑时出现，重置成当前模型没有意义

  /**
   * 保存写的是**这一条档案**（新增则创建），不是"全局那一份设置" ——
   * 多模型之后用户此刻编辑的就是某一条模型，语义上必须"存进这一条"。
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
        setNotice({ ok: true, text: apiKey ? '已保存（API Key 已加密存储）' : '已保存' })
        return
      }
      // 理论到不了这儿（表单只在编辑时出现）；留着是为了万一有别的入口
      const view = await window.api.saveSettings({ ...draft, apiKey })
      useAppStore.setState({ settings: view })
      setApiKey('')
      setNotice({ ok: true, text: apiKey ? '已保存（API Key 已加密存储）' : '已保存' })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  /** 编辑态的 Key 状态取**这条端点自己的**（models 列表真值）；新增态没有档案 → undefined → 显示「尚未保存」 */
  const editingProfile = editingModel?.id ? models?.profiles.find((p) => p.id === editingModel.id) : undefined

  /**
   * 新增态测试连接：模型 ID 取**表单模型目录**的第一条非空值。
   * ⚠️ draft.model 是通用设置的残留值（startCreate 从 settings 拷贝），与正在新增的端点无关——
   * 拿它打到新 baseURL 必报 Unsupported model（0.13.43 实测）。
   */
  const testDraftConnection = async (): Promise<TestResult> => {
    if (!draft) return { ok: false, message: '表单尚未初始化' }
    const modelId = draftModels.map((m) => m.model.trim()).find(Boolean)
    if (!modelId) return { ok: false, message: '请先在「模型目录」填写模型 ID，再测试连接' }
    return window.api.testConnection({ ...draft, model: modelId, apiKey })
  }

  const test = async (): Promise<void> => {
    if (!draft) return
    setTesting(true)
    setNotice(null)
    try {
      // 编辑既有模型 → 测**它自己**（用它已存的 Key，不必重填）；新增中 → 用表单里的值现测（还没入库，没档案可测）
      const result = editingModel?.id
        ? await window.api.testModel(editingModel.id)
        : await testDraftConnection()
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

  /** 恢复内置默认工作区（plan7 批 F4）：取数一律走主进程返回值回显，不做乐观更新 */
  const resetWs = async (): Promise<void> => {
    setWs(await window.api.resetWorkspace())
  }

  // ── 存储位置（plan10 C 批）：写 pending、下次启动迁移生效；结果人话直显 ──
  const pickStorage = async (): Promise<void> => {
    const res = await window.api.pickStorageDir()
    if ('canceled' in res) return
    if (res.ok) {
      setStorage(res.info)
      setNotice({ ok: true, text: '已保存，将在下次启动时迁移数据并生效' })
    } else {
      setNotice({ ok: false, text: res.reason })
    }
  }

  const resetStorage = async (): Promise<void> => {
    const res = await window.api.resetStorageLocation()
    if ('canceled' in res) return
    if (res.ok) {
      setStorage(res.info)
      setNotice({ ok: true, text: '已保存，下次启动时数据将迁回默认目录' })
    } else {
      setNotice({ ok: false, text: res.reason })
    }
  }

  const undoStoragePending = async (): Promise<void> => {
    const res = await window.api.undoStoragePending()
    if ('canceled' in res) return
    if (res.ok) setStorage(res.info)
  }

  const choosePerm = async (p: PermissionPreset): Promise<void> => {
    setPerm(await window.api.setPermission(p))
  }

  /** 电脑控制开关（2026-09-15）：主进程返回值回显，不做乐观更新 */
  const chooseCC = async (value: boolean): Promise<void> => {
    setCcEnabled(await window.api.setComputerControl(value))
  }

  /** 选省 token 档位：**全局一档**，不做会话级覆盖（用户定调） */
  const chooseTier = async (next: TokenSaverTier): Promise<void> => {
    setTier(await window.api.setTokenTier(next))
  }

  // ── 多模型：增删改与"改用这个"（plan7 F5）──
  //
  // 三条纪律：① **删除先确认**（红线），确认框里说清它叫什么；② **至少要留一个** —— 护栏在主进程，
  // 这里只把它的理由原样显示；③ 每次改动都 `refreshModels()` 重新拉真值，不在本地猜一份（列表就是真值）。

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
    // 表单只管**连接级**四项（协议 / 地址 / 超时 / 流式）；采样、输出上限、上下文窗口那些
    // "模型级"参数归目录里每个模型自己的高级设置（F5.1）。
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

  /** 切到某端点下的某个模型（组下清单的「用这个」）：端点没激活就一并激活 */
  const useModelEntry = async (profileId: string, entryId: string): Promise<void> => {
    setModelNotice(null)
    try {
      let next = await window.api.setActiveModelEntry(profileId, entryId)
      if (models && profileId !== models.activeId) next = await window.api.setActiveModel(profileId)
      setModels(next)
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
    if (!window.confirm(`删除模型「${target?.name ?? id}」？\n\n该模型的 API Key 将一并删除（工作区文件不受影响）。`)) {
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
            {/* 承重定位（plan7 批 F4）：这里改的是"新任务的默认落点"；老会话绑定当时的工作区，不受影响 */}
            <p className="hint">Agent 只能读写该目录下的文件，越界操作会被拒绝。新任务默认在这个目录进行。</p>
            <p className="hint">已创建的会话各自绑定当时的工作区，改这里不影响它们。</p>
            <div className="logs-info">
              <span className="logs-path">{ws?.path ?? '加载中…'}</span>
              {ws && !ws.custom && <span className="logs-count">内置默认</span>}
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={() => void pickWs()}>
                选择目录…
              </button>
              {/* 只在自定义档给得出退路：内置默认档下这个按钮是空操作，禁用比点了没反应诚实 */}
              <button
                className="btn-secondary"
                disabled={!ws?.custom}
                onClick={() => void resetWs()}
              >
                恢复内置默认
              </button>
              <button
                className="btn-secondary"
                disabled={!ws}
                onClick={() => ws && void window.api.revealWorkspace(ws.path)}
              >
                打开目录
              </button>
            </div>

            <div className="field-label">存储位置</div>
            {/* plan10 C 批：应用自身数据（会话/设置/检查点等）的落点。改的是"数据搬到哪"，
                与上面"Agent 干活的边界"（工作区）是两件事。迁移只在启动时做，避免边用边搬 */}
            <p className="hint">会话、设置、检查点等应用数据保存在这里。更改后将在下次启动时迁移生效。</p>
            <p className="hint">只迁移应用自身数据；浏览器缓存留在原处自动重建。迁移后原目录保留作为回退。</p>
            <div className="logs-info">
              <span className="logs-path">{storage?.current ?? '加载中…'}</span>
              {storage && !storage.custom && <span className="logs-count">默认位置</span>}
              {storage?.custom && <span className="logs-count">自定义</span>}
            </div>
            {/* 待生效迁移：用户选了新目录（或要回默认）但还没重启 —— 必须显式提醒，否则"点了没反应" */}
            {storage?.pendingDir && (
              <div className="logs-info">
                <span className="logs-path">
                  {storage.pendingKind === 'restore'
                    ? '下次启动将迁回默认目录'
                    : `下次启动将迁移到：${storage.pendingDir}`}
                </span>
                <button className="btn-secondary" onClick={() => void undoStoragePending()}>
                  撤销
                </button>
              </div>
            )}
            {/* 最近一次启动时的迁移结果（成功提示 / 失败原因）。at 只精确到"发生过"，不抢 notice 的戏 */}
            {storage?.lastEvent && (
              <p className="hint" style={storage.lastEvent.kind === 'error' ? { color: 'var(--danger)' } : undefined}>
                {storage.lastEvent.kind === 'error' ? '迁移失败：' : '已完成：'}
                {storage.lastEvent.text}
              </p>
            )}
            <div className="actions">
              <button className="btn-secondary" onClick={() => void pickStorage()}>
                更改…
              </button>
              {/* 与工作区同款纪律：默认档下"恢复默认"是空操作，禁用比点了没反应诚实 */}
              <button className="btn-secondary" disabled={!storage?.custom} onClick={() => void resetStorage()}>
                恢复默认位置
              </button>
              <button
                className="btn-secondary"
                disabled={!storage}
                onClick={() => storage && void window.api.revealWorkspace(storage.current)}
              >
                打开目录
              </button>
            </div>

            {/* 注释收进 ⓘ（2026-09-14 用户定调：界面极简，说明不直接显示）；trouble 行保留 —— 它是"设了不等于生效"的实时状态，不是注释 */}
            <div className="field-label field-label-with-note">
              访问权限
              <FieldNote
                text={[
                  '与输入框工具栏为同一设置，两处修改等效。',
                  `只读访问：${PERM_HINT['read-only']}`,
                  `可写访问：${PERM_HINT['write']}`,
                  `完全访问：${PERM_HINT['full-access']}`
                ]}
              />
            </div>
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
                </button>
              ))}
            </div>

            {/* ── 电脑控制（2026-09-15 用户需求）── 当前版本尚未搭载对应工具：开关先落门控，
                状态进模型自视段（如实报告）；工具上线后此处即权限闸。开着时必须当场说明现状，
                防"以为已经在被控制"的错觉。 */}
            <div className="field-label field-label-with-note">
              电脑控制
              <FieldNote
                text={[
                  '允许模型操控鼠标键盘、与桌面应用程序交互。',
                  '当前版本尚未搭载电脑控制工具；开关保存偏好，功能上线后作为权限闸生效。'
                ]}
              />
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={ccEnabled ?? false}
                disabled={ccEnabled === null}
                onChange={(e) => void chooseCC(e.target.checked)}
              />
              启用电脑控制
            </label>
            {ccEnabled === true && (
              <p className="hint">已开启。当前版本暂无可用的电脑控制工具；该设置将在功能上线后作为权限闸生效。</p>
            )}

            {/* 省 token 的口号不写在这里 —— 它是"能力 vs 省钱"的取舍，摆进 ⓘ 里让人自己选，
                不替用户默认一个激进值（plan8 R9.1 §七②）。 */}
            <div className="field-label field-label-with-note">
              Token Saver
              <FieldNote
                text={[
                  '仅影响省 Token 的手段（工具输出的压缩力度、读文件默认行数），不修改计量口径，也不省略厂商未上报的数据。',
                  ...TOKEN_TIER_LIST.map((t) => `${t.label}：${t.note}`)
                ]}
              />
            </div>
            <div className="choice-list choice-list-fill" role="radiogroup" aria-label="Token Saver 档位">
              {TOKEN_TIER_LIST.map((t) => (
                <button
                  key={t.tier}
                  role="radio"
                  aria-checked={tier === t.tier}
                  className={`choice-item${tier === t.tier ? ' is-on' : ''}`}
                  onClick={() => void chooseTier(t.tier)}
                >
                  <span className="choice-name">{t.label}</span>
                </button>
              ))}
            </div>

            <div className="field-label">界面布局</div>
            {/* 不写"怎么拖分隔条"：可拖动是直觉操作、双击复位是彩蛋，不值得占一行浅字 */}
            <div className="actions">
              <button
                className="btn-secondary"
                onClick={() => void useAppStore.getState().resetUIPrefs()}
              >
                恢复默认布局
              </button>
            </div>

            {/* ── 系统（plan7 批 F1）：两项都是**系统级副作用**，代价说明收进组 ⓘ；
                "设了不等于生效"的 trouble 行**保留直接显示** —— 它是实时状态不是注释。 */}
            <div className="field-label field-label-with-note">
              系统
              <FieldNote text={SYSTEM_TOGGLES.map((t) => `${t.label}：${t.note}`)} />
            </div>
            {SYSTEM_TOGGLES.map((t) => {
              const unsupported = t.key === 'openAtLogin' && sys !== null && !sys.openAtLoginSupported
              // 「设了」与「生效了」不一致时**必须当场说**（plan7 点名的"以为在跑、其实被挂起了"）：
              // 故这里用**意图 vs 生效**的组合判据，只看错误位会漏掉"没有任何报错但就是不生效"那条路
              const trouble = !sys
                ? null
                : t.key === 'keepRunning'
                  ? (sys.keepRunningError ??
                    (sys.keepRunning === sys.keepRunningActive
                      ? null
                      : sys.keepRunning
                        ? '设置已保存，但当前未生效：系统未接受阻止睡眠的请求。'
                        : '关闭未成功：系统当前仍不会自动睡眠。'))
                  : (sys.openAtLoginError ??
                    (unsupported
                      ? sys.openAtLoginReason
                      : sys.openAtLogin && !sys.openAtLoginActive
                        ? '启动项已写入，但系统不会在登录时拉起本应用（可能已在任务管理器或系统设置里停用）。'
                        : null))
              return (
                <Fragment key={t.key}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={sys ? sys[t.key] : false}
                      disabled={!sys || unsupported}
                      onChange={(e) => void chooseSystem(t.key, e.target.checked)}
                    />
                    {t.label}
                  </label>
                  {trouble && <p className="hint">{trouble}</p>}
                </Fragment>
              )
            })}

            {/* ── 网络代理（plan7 批 F2）── 组说明与各选项 note 收进 ⓘ；
                「当前生效」探测行**保留直接显示** —— 配错代理的表现是超时，只有它能分开
                「没生效」与「生效了但连不上」。 */}
            <div className="field-label field-label-with-note">
              网络
              <FieldNote
                text={[
                  '代理只影响之后发起的请求，已经建立的连接不受影响。模型请求与内置浏览器都走这里的配置。',
                  ...PROXY_MODES.map((m) => `${m.label}：${m.note}`)
                ]}
              />
            </div>
            {PROXY_MODES.map((m) => (
              <label className="checkbox" key={m.key}>
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={net?.proxyMode === m.key}
                  disabled={!net}
                  onChange={() => void applyNetwork({ proxyMode: m.key })}
                />
                {m.label}
              </label>
            ))}

            {net?.proxyMode === 'custom' && (
              <>
                <label>
                  代理地址
                  <input
                    value={netRules}
                    placeholder="127.0.0.1:7897"
                    onChange={(e) => setNetRules(e.target.value)}
                  />
                </label>
                <label>
                  账号（可选）
                  <input
                    value={netUser}
                    placeholder={net.hasCredentials ? '已保存，留空表示不修改' : '如 corp\\用户名'}
                    onChange={(e) => setNetUser(e.target.value)}
                  />
                </label>
                <label>
                  密码（可选）
                  <input
                    type="password"
                    value={netPass}
                    placeholder={net.hasCredentials ? '已保存，留空表示不修改' : ''}
                    onChange={(e) => setNetPass(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() =>
                      void applyNetwork({
                        proxyRules: netRules,
                        // undefined = 不动；空串 = 用户没填 → 同样当不动（清除走下面那个按钮）
                        proxyUser: netUser.length > 0 ? netUser : undefined,
                        proxyPass: netPass.length > 0 ? netPass : undefined
                      })
                    }
                  >
                    应用
                  </button>
                  {net.hasCredentials && (
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={() => void applyNetwork({ proxyUser: null, proxyPass: null })}
                    >
                      清除已保存的账号密码
                    </button>
                  )}
                </div>
              </>
            )}

            <p className="hint">
              当前生效：{describeProxy(net?.effective ?? null)}
              {net?.effectiveFor ? `（按 ${net.effectiveFor} 探测）` : `（按 ${PROXY_PROBE_URL} 探测）`}
            </p>
            {net && !net.applied && net.error && <p className="hint">{net.error}</p>}
            {net?.effectiveError && <p className="hint">探测失败：{net.effectiveError}</p>}

            {/* ── Firecrawl（plan32）：web_search 的密钥型搜索源；没配回落内置默认源 ── */}
            <div className="field-label">网页搜索（可选）</div>
            <label>
              Firecrawl API Key
              <input
                type="password"
                value={fcInput}
                placeholder={fcHas ? '已保存，留空表示不修改' : 'fc-…（在 firecrawl.dev 获取）'}
                onChange={(e) => setFcInput(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                className="btn-secondary"
                type="button"
                disabled={fcInput.length === 0}
                onClick={() => void applyFirecrawl(fcInput)}
              >
                保存
              </button>
              {fcHas && (
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => void applyFirecrawl(null)}
                >
                  清除已保存的 Key
                </button>
              )}
            </div>
            <p className="hint">
              {fcHas
                ? '已配置：web_search 优先走 Firecrawl，失败自动回落默认搜索源。'
                : '未配置：web_search 使用内置默认搜索源（无需密钥）。'}
            </p>
            {fcError && <p className="hint">{fcError}</p>}
          </div>
        )}

        {section === 'model' && (
          <>
            {/* ⚠️ 标题与列表在**编辑时让位给二级页**（2026-09-13）：二级页自带「← 返回」，
                两套导航同时出现会让人不知道该点哪个。 */}
            {!editingModel && <h2>模型</h2>}

            {/* ── 模型列表（plan7 F5 多模型管理）──────────────────────────────
                为什么要有"当前用哪个"：列表没有当前态就是一坨 —— 用户看不出正在用谁。
                （路径来自主进程的真值，不硬编码 —— 说得出口就得是真的） */}
            {!editingModel && (
            <div className="model-head">
              <div className="model-head-text">
                <div className="model-head-title">自定义模型</div>
                <p className="hint">
                  模型配置保存后写入本地 <code className="model-file">{models?.filePath ?? '…'}</code> 文件
                </p>
              </div>
              <button className="btn-secondary model-add" onClick={startCreate}>
                添加模型
              </button>
            </div>
            )}

            {!editingModel && models && models.profiles.length === 0 && (
              <p className="hint">尚未添加模型。</p>
            )}

            {!editingModel && models && models.profiles.length > 0 && (
              <div className="model-list">
                {models.profiles.map((p) => (
                  <div key={p.id} className="model-group">
                    <div className={`model-row ${p.id === models.activeId ? 'on' : ''}`}>
                      <span className="model-mark" aria-hidden>
                        {p.source === 'deepseek' ? <IconWhale /> : <IconSpark />}
                      </span>
                      <span className="model-name" title={p.name}>
                        {p.name}
                      </span>
                      <span className="model-source">{sourceLabel(p.source)}</span>
                      {p.id === models.activeId && <span className="model-current">当前</span>}
                      <span className="model-actions">
                        <button className="model-act" title="编辑该模型" onClick={() => startEdit(p)}>
                          <IconPencil />
                        </button>
                        <button
                          className="model-act"
                          title={p.hasApiKey ? '测试连接（使用该模型已保存的 API Key）' : '尚未填写 API Key'}
                          disabled={modelBusy === p.id}
                          onClick={() => void testProfile(p.id)}
                        >
                          <IconLink />
                        </button>
                        <button className="model-act model-act-del" title="删除该模型" onClick={() => void removeProfileById(p.id)}>
                          <IconTrash />
                        </button>
                        {p.id !== models.activeId && (
                          <button
                            className="model-act model-act-use"
                            title="切换为该模型"
                            onClick={() => void useProfile(p.id)}
                          >
                            改用
                          </button>
                        )}
                      </span>
                    </div>
                    {/* 组下模型清单（2026-09-15 用户需求）：同一条 Key 的全部模型摆在组名下，点「用这个」即切 */}
                    <div className="model-entries">
                      {p.models.map((m) => {
                        const cur = p.id === models.activeId && m.id === p.activeModelId
                        return (
                          <div key={m.id} className={`model-entry ${cur ? 'on' : ''}`}>
                            <span className="model-entry-name" title={m.model}>
                              {entryLabel(m)}
                            </span>
                            {m.name?.trim() ? <span className="model-entry-id">{m.model}</span> : null}
                            {cur ? (
                              <span className="model-entry-cur">当前模型</span>
                            ) : (
                              <button
                                className="model-entry-use"
                                title="切换为该模型"
                                onClick={() => void useModelEntry(p.id, m.id)}
                              >
                                用这个
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!editingModel && modelNotice && (
              <div className={modelNotice.ok ? 'notice-ok' : 'notice-err'}>{modelNotice.text}</div>
            )}

            {/* ── 编辑表单：**第二级页面**（2026-09-13，设置改独立窗口）──
                形态对齐用户给的 WorkBuddy 参考图：点「添加模型」→ 整块换成表单页 + 左上角「← 返回」，
                而**不是**在列表下面就地展开半屏表单。
                为什么换成二级页：① 参考图就是这个形态；② 表单很长（显示名/baseURL/模型目录/协议/Key），
                就地展开会把列表挤到看不见，"我正在编辑哪一条"失去参照。 */}
            {editingModel && (
              <div className="settings-subpage">
                <button className="back-btn" type="button" onClick={cancelEdit}>
                  ← 返回
                </button>
                <div className="model-form-title">{editingModel.id ? '编辑模型' : '添加模型'}</div>

                <label>
                  显示名称（用于列表显示）
                  <input
                    value={draftName}
                    placeholder="如 DeepSeek-V4 Flash"
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </label>

                <p className="hint">API Key 由系统加密存储（safeStorage）保存，不以明文落盘。</p>

                <label>
                  接口地址 baseURL
                  <input
                    value={draft.baseURL}
                    placeholder="如 https://api.deepseek.com（/v1 可选）"
                    onChange={(e) => update('baseURL', e.target.value)}
                  />
                </label>
                {/* **模型目录**（plan7 F5.1）：一把 Key 能调的模型都放这儿，每个还能各自展开高级设置 */}
                <ModelCatalogEditor
                  models={draftModels}
                  onChange={setDraftModels}
                  onFetch={async () => {
                    if (!editingModel?.id) {
                      // 判定的是「端点尚未入库」（新增态没有 id），文案必须说清动作是保存，而非"没填地址/Key"
                      return { ok: false, message: '该端点尚未保存，请先点「保存模型」，再拉取模型列表', models: [] }
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

            {/* Key 状态读**当前编辑端点**的（models 列表里的真值），不读通用 settings ——
                ⚠️ settings.hasApiKey 是通用设置（官方档案）的 Key，新建端点时显示它会让人误以为 Key 已存进这条 */}
            <label>
              API 密钥（{editingProfile?.hasApiKey ? `已保存：${editingProfile.apiKeyMasked}` : '尚未保存'})
              <input
                type="password"
                value={apiKey}
                placeholder={editingProfile?.hasApiKey ? '留空则保留已保存的 Key' : 'sk-...'}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>


            {/* 承重句（会花钱，得先说）—— 只把主语去掉，不删 */}
            <p className="hint">该操作会发起一次真实请求，消耗少量 Token。</p>

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
              </div>
            )}
          </>
        )}

        {section === 'voice' && <VoiceSettingsPanel />}
        {section === 'dev-env' && <DevEnvSettings />}
        {section === 'agents' && <AgentManager />}
        {section === 'skills' && <SkillsPanel />}
        {section === 'mcp' && (
          <>
            <ComputerUseRecommend />
            <McpPanel />
          </>
        )}

        {section === 'memory' && <MemorySettings />}

        {section === 'appearance' && (
          /* 主题切换，切换即时生效并持久化；各主题说明收进组 ⓘ（2026-09-14 界面极简定调） */
          <div className="settings-section">
            <h2>外观</h2>
            {/* 不写"切换立即生效，重启后保持"：那是**一切设置**的共性，说了等于没说。
                ⚠️ 主题名本身自解释（0.13.41 反馈）：组 ⓘ 撤除，说明留在 THEMES 的 desc 里备查 */}
            <div className="field-label">主题</div>
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
                </button>
              ))}
            </div>

            <div className="field-label">界面字号</div>
            {/* 字号档（plan7 批 F3）：实现是根元素 font-size 缩放，全站 rem token 一起动。
                档位由 shared 的 FONT_SCALES 出，这里不另拍一组数；改了即时生效。
                ⚠️ 末档（特大）单独占满一行且文字居中 —— 0.13.41 反馈：孤零零卡在左上不对称 */}
            <div className="choice-list choice-list-fontscale" role="radiogroup" aria-label="界面字号">
              {FONT_SCALES.map((s) => (
                <button
                  key={s.key}
                  role="radio"
                  aria-checked={fontScale === s.key}
                  className={`choice-item${fontScale === s.key ? ' is-on' : ''}`}
                  onClick={() => setFontScale(s.key)}
                >
                  <span className="choice-name">{s.label}</span>
                </button>
              ))}
            </div>

            <div className="field-label">界面字体</div>
            {/* 字体枚举在主进程（渲染端 document.fonts 只有已加载的）：列得出就给下拉框，
                列不出就明说原因并退化为手动输入 —— **不做假下拉框**（plan7 批 F3 原话）。 */}
            {fonts?.ok ? (
              <label>
                字体
                <select
                  value={uiFont}
                  onChange={(e) => setUiFont(e.target.value)}
                  aria-label="界面字体"
                >
                  <option value="">默认（Segoe UI / 微软雅黑）</option>
                  {fonts.fonts.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                字体（手动输入）
                <input
                  value={uiFont}
                  placeholder="如 Microsoft YaHei"
                  onChange={(e) => setUiFont(e.target.value)}
                />
              </label>
            )}
            {fonts && !fonts.ok && fonts.message && <p className="hint">{fonts.message}</p>}
            {/* 预览行是功能不是注释，保留直接显示（用户拍板） */}
            <p className="hint">
              预览（切换后全站生效）：
              <span style={uiFont ? { fontFamily: `'${uiFont}', sans-serif` } : undefined}>
                中文字体 Abc 123 —— The quick brown fox
              </span>
            </p>
          </div>
        )}

        {section === 'trouble' && (
          /* 故障排查入口（plan8 R2）：出问题时能一键找到日志，而不是只看到"出错了" */
          <div className="settings-section">
            <h2>故障排查</h2>
            {/* 承重（隐私 + 怎么用），但一句话说得完 */}
            <p className="hint">日志保存在本地，已过滤 API Key 等敏感信息；反馈问题时附上最近的日志文件。</p>
            <div className="logs-info">
              <span className="logs-path">
                {logs?.dir ?? '日志目录尚未创建，产生首条日志后自动出现'}
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