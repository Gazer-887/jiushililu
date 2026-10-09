import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { activeEntry, entryLabel, sourceLabel, type ModelEntry, type ModelProfileView, type ModelsView } from '@shared/models'
import { cacheHitRate, formatRate, formatTokens, reasoningShare, totalTokens } from '@shared/usage'
import { tierLabel } from '@shared/token-tier'
import type { GitInfo, PermissionPreset, ReasoningConfig } from '@shared/ipc'
import { KNOWN_EFFORT_LEVELS, effortToSend, sortEffortLevels } from '@shared/reasoning'

// 输入框工具栏零件（P2 控制台）：模型切换 / 上下文圆环 / 权限档 / Git 分支 / 提示词优化。

const WARN = 0.75
const DANGER = 0.9

/** 上下文用量圆环（本地估算，不是厂商真实用量） */
export function ContextRing({ used }: { used: number }): JSX.Element {
  const limit = useAppStore((s) => s.settings?.contextWindow ?? 0)
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const level = ratio >= DANGER ? 'danger' : ratio >= WARN ? 'warn' : 'ok'
  const pct = limit > 0 ? Math.round(ratio * 100) : 0
  const R = 8
  const C = 2 * Math.PI * R

  return (
    <span
      className={`ctx-ring ctx-${level}`}
      title={limit > 0 ? `上下文用量约 ${used} / ${limit} tokens` : '上下文窗口未设置（可在输入框「窗口」芯片或设置页调整）'}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${ratio * C} ${C}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className="ctx-ring-text">{pct}%</span>
    </span>
  )
}

/**
 * **真实用量小牌**（plan8 R9）。与圆环是两件事：圆环是本地估算的上下文占用（永远有值），
 * 这块牌是厂商**真实报的** token 账（准确，但厂商不报时就没有）。
 * 故厂商没报时**不渲染**而不是显示 0（0 会让人以为"这轮不要 token"）；只出 token 不出金额。
 */
export function UsageChip(): JSX.Element | null {
  const record = useAppStore((s) => (s.activeId ? s.usageByConversation[s.activeId] : undefined))

  // 没会话、或还没拿到过真实用量 → 整块不渲染（工具栏不为"暂无"占位）
  if (!record || (!record.usageReported && record.avoided <= 0 && record.memory <= 0 && !record.reflectionTotal)) return null

  const { total, last, avoided, memory, reflectionTotal } = record
  /**
   * 命中率与思考占比（plan8 R9.1）。`null` = **厂商没报这个数** → 什么都不显示（连 0% 都不写，
   * 写 0% 等于替厂商宣布"一点没命中"）。但 `思考 0%` 会出现：厂商明确报了 0 就是事实，该显示。
   * 这两种 0 走两条路，见 @shared/usage。
   */
  const hit = record.usageReported ? cacheHitRate(total) : null
  const think = record.usageReported ? reasoningShare(total) : null
  const tip = [
    record.usageReported ? `主对话已上报合计：${totalTokens(total)} tokens` : '主对话用量：厂商未上报或旧记录来源未知',
    record.usageReported ? `输入 ${formatTokens(total.promptTokens)} · 输出 ${formatTokens(total.completionTokens)}` : '',
    record.usageReported ? (record.usageComplete === true ? '覆盖：本轮链路各请求均有报告' : record.usageComplete === false ? '覆盖：仅已上报部分，存在未报告请求' : '覆盖：旧记录未记范围') : '',
    record.usageReported ? (total.cachedPromptTokens == null ? '前缀缓存命中：厂商未上报'
      : `其中前缀缓存命中：${formatTokens(total.cachedPromptTokens)}（${hit === null ? '输入为0，比例不适用' : formatRate(hit)}）`) : '',
    record.usageReported ? (total.reasoningTokens == null ? '输出里推理（思考）：厂商未上报'
      : `输出里推理（思考）：${formatTokens(total.reasoningTokens)}（${think === null ? '输出为0，比例不适用' : formatRate(think)}）`) : '',
    last ? `最近一轮已上报：${totalTokens(last)} tokens${record.lastComplete === false ? '（部分）' : ''}` : '',
    // 记下"这轮是哪一档跑的" —— 用户比数字时得知道它的出处（plan8 §七②）
    record.tier ? `省 Token 档位（设置页可修改）：${tierLabel(record.tier)}` : '',
    // ⚠️ 这行必须**说清是估算**：它与上面的"厂商真实值"不同源，不说清用户没法判断哪个数能信。
    avoided > 0 ? `工具输出成形省下（本地估算）：约 ${formatTokens(avoided)} tokens` : '',
    // 注入税（plan19 §5.2）：记忆段每轮占掉的**估算** token —— 它是"越用越重"的直接读数。
    // 同样必须说清是估算；没有记忆时不显示（不是显示 0，那等于宣布"没有开销"）
    memory > 0 ? `记忆注入税（本地估算）：约 ${formatTokens(memory)} tokens` : '',
    // 批 2 反思用量：会话切换时跑的额外模型调用，与对话账分开（不进 total）
    reflectionTotal
      ? `反思用量（切换会话时调用）：${totalTokens(reflectionTotal)} tokens`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className="usage-chip" title={tip}>
      {record.usageReported && <>
        <span className="usage-total">{formatTokens(totalTokens(total))}</span>
        <span className="usage-unit">tok</span>
      </>}
      {last && <span className="usage-last">+{formatTokens(totalTokens(last))}</span>}
      {hit !== null && <span className="usage-rate">命中 {formatRate(hit)}</span>}
      {think !== null && <span className="usage-rate">思考 {formatRate(think)}</span>}
      {/* 主进程没带这个字段就**不显示** —— 不替它编一个默认档 */}
      {record.tier && <span className="usage-tier">{tierLabel(record.tier)}</span>}
      {avoided > 0 && <span className="usage-saved">省 {formatTokens(avoided)}(估)</span>}
      {/* 注入税（plan19 §5.2）：本地估算，照既有诚实口径标"估" */}
      {memory > 0 && <span className="usage-memory">记忆税 {formatTokens(memory)}(估)</span>}
      {/* 批 2 反思用量：会话切换时跑的额外模型调用，与对话账分开 */}
      {reflectionTotal && (
        <span className="usage-reflection">反思 {formatTokens(totalTokens(reflectionTotal))}</span>
      )}
    </span>
  )
}

/**
 * 模型快速切换（plan7 F5 之后）：**切的是档案，不是名字**（数据与设置页同一份 `models:list`）。
 * 不靠手输模型名 —— 多模型下光改名字 = 拿新名字去撞**当前那条连接**，多半 400；
 * 换模型去设置页「添加模型」，这里的手输按名字在全目录精确切换（plan39：不再改名）。
 *
 * 分组显示（2026-09-15 用户需求）：端点为组、组名做标题，组下逐条列模型目录，
 * 点模型 = 切到它（端点没激活时一并切）；当前正在用的那条打勾。
 */
export function ModelSwitcher(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelsView | null>(null)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开时才拉列表：这是"用了才查"的数据，不占首屏
  useEffect(() => {
    if (!open) return
    void window.api
      .listModels()
      .then(setModels)
      .catch(() => setModels(null))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /** 切到某端点的某个模型：端点没激活就一并激活（一次点击 = 定格到这个模型） */
  const useEntry = async (profileId: string, entryId: string): Promise<void> => {
    let next = await window.api.setActiveModelEntry(profileId, entryId)
    if (models && profileId !== models.activeId) next = await window.api.setActiveModel(profileId)
    setModels(next)
    await loadSettings()
    setOpen(false)
  }

  /** 按名字精确切到目录里任一模型（可跨端点）；对不上**不改名**，只报错指路（plan39 D-101） */
  const apply = async (model: string): Promise<void> => {
    const name = model.trim()
    if (!name) return
    const res = await window.api.setModel(name)
    if (!res.ok) useAppStore.setState({ streamError: res.message ?? '模型切换失败' })
    await loadSettings()
    setDraft('')
    setOpen(false)
  }

  const active = models?.profiles.find((p) => p.id === models.activeId) ?? null
  const activeModel = active ? activeEntry(active) : null
  const label = activeModel ? entryLabel(activeModel) : (settings?.model ?? '未配置模型')
  const labelTitle = active ? `${active.name} / ${activeModel?.model ?? ''}` : '切换模型'

  return (
    <div className="model-switch" ref={boxRef}>
      <button className="tb-btn tb-model" onClick={() => setOpen((v) => !v)} title={labelTitle}>
        {label}
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          {models && models.profiles.length > 0 ? (
            models.profiles.map((p) => (
              <div key={p.id} className="model-menu-group">
                <div className="model-group-head">
                  <span className="model-group-name" title={p.name}>
                    {p.name}
                  </span>
                  <span className="model-group-src">{sourceLabel(p.source)}</span>
                </div>
                {p.models.map((m) => {
                  const cur = p.id === models.activeId && m.id === p.activeModelId
                  return (
                    <button
                      key={m.id}
                      className={`model-item ${cur ? 'active' : ''}`}
                      onClick={() => void useEntry(p.id, m.id)}
                      title={`${p.name} / ${m.model}`}
                    >
                      {entryLabel(m)}
                      {cur && <span className="model-item-cur">✓</span>}
                    </button>
                  )
                })}
              </div>
            ))
          ) : (
            <button className="model-item" onClick={() => setOpen(false)}>
              {settings?.model || '尚未配置模型'}
              <span className="model-item-src">在设置页添加</span>
            </button>
          )}
          <div className="model-new">
            <input
              value={draft}
              placeholder="输入目录中的模型名切换，回车确认"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void apply(draft)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** 权限档文案：设置页「通用设置」也读它 —— 单一真相源，别写两份 */
export const PERM_LABEL: Record<PermissionPreset, string> = {
  'read-only': '只读访问',
  write: '可写访问',
  'full-access': '完全访问'
}

export const PERM_HINT: Record<PermissionPreset, string> = {
  'read-only': '模型只能读取工作区内的文件，不能修改。',
  write: '可读写工作区内文件；执行命令仍需逐次授权。',
  // plan29 D-089：档位「名实相符」后，这一档的边界从"免确认"扩到了"文件系统无边界"——
  // 文案必须**同时**把这两件事说出来。只说"不逐次确认"，用户不会知道模型现在能碰工作区外的文件。
  'full-access': '可读写工作区**外**的任意文件（不再限制在工作区内）；含命令执行，且不再逐次确认。谨慎使用。'
}

/** 访问权限档（D-032：唯一由人决定的档位 —— 能力归模型，权限归人） */
export function PermissionChip(): JSX.Element {
  const [preset, setPreset] = useState<PermissionPreset>('write')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.getPermission().then(setPreset)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = async (p: PermissionPreset): Promise<void> => {
    setPreset(await window.api.setPermission(p))
    setOpen(false)
  }

  return (
    <div className="perm-wrap" ref={boxRef}>
      <button
        className={`tb-btn tb-perm perm-${preset}`}
        title={PERM_HINT[preset]}
        onClick={() => setOpen((v) => !v)}
      >
        {PERM_LABEL[preset]}
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="tb-menu">
          {(Object.keys(PERM_LABEL) as PermissionPreset[]).map((p) => (
            <button
              key={p}
              className={`tb-menu-item ${p === preset ? 'active' : ''}`}
              onClick={() => void choose(p)}
            >
              <span className="tb-menu-title">{PERM_LABEL[p]}</span>
              <span className="tb-menu-desc">{PERM_HINT[p]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 模型 chip 共用的数据机（plan58 R1「回显主进程真值」纪律的实现处）：
 * 拉 `models:list` 找激活条目，广播来了重读 —— 两枚 chip（思考 / 窗口）共用，
 * **重读而不是搬变更内容**（多窗口铁律）。
 */
function useActiveModelEntry(): {
  setModels: (v: ModelsView | null) => void
  active: ModelProfileView | null
  entry: ModelEntry | null
} {
  const [models, setModels] = useState<ModelsView | null>(null)
  const reload = useCallback((): void => {
    void window.api
      .listModels()
      .then(setModels)
      .catch(() => setModels(null))
  }, [])
  useEffect(() => {
    reload()
  }, [reload])
  useEffect(() => window.api.onSettingsChanged(() => reload()), [reload])
  const active = models?.profiles.find((p) => p.id === models.activeId) ?? null
  const entry = active ? activeEntry(active) : null
  return { setModels, active, entry }
}

/**
 * 思考强度 chip（plan58 片② R7）：一个位置，形状随 `reasoning.kind` 变 ——
 * `effort` 档名单元 / `toggle` 二态开关 / `budget_tokens` 预算框 / `none` 与未声明**不出现**（Q12，
 * 不给存量档案凭空造档）。回显纪律同 PermissionChip（R1）：**读主进程真值** ——
 * patch 的返回值就是最新视图，不本地自说自话；广播来了重读，不搬变更内容（多窗口铁律）。
 */
export function ReasoningChip(): JSX.Element | null {
  const { setModels, active, entry } = useActiveModelEntry()
  const [open, setOpen] = useState(false)
  const [draftBudget, setDraftBudget] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const rs = entry?.settings?.reasoning
  if (!active || !entry || !rs || rs.kind === 'none') return null

  const patch = async (next: {
    reasoningEffort?: string
    reasoning?: ReasoningConfig
  }): Promise<void> => {
    const view = await window.api.patchModelEntry({ profileId: active.id, entryId: entry.id, patch: next })
    setModels(view)
  }

  const isAnthropic = active.providerType === 'anthropic'
  // 缺陷 2（R5）：Anthropic 带工具的轮次不开思考 —— 这是协议限制，不是用户的选择，必须上界面
  const anthropicNote = isAnthropic ? '带工具时该端点不开思考。' : ''

  // toggle：二态开关，没有菜单（Q11 断言此处档名单元不存在）
  if (rs.kind === 'toggle') {
    const on = rs.enabled === true
    const cannotOff = !on && (rs.offEncoding ?? 'omit') === 'omit'
    const title = [
      on ? '思考已开：下一轮请求起生效。' : '思考已关：下一轮请求起生效。',
      cannotOff ? '未声明关闭编码：对默认开思考的端点，关闭可能不生效。' : '',
      anthropicNote
    ]
      .filter(Boolean)
      .join('\n')
    return (
      <div className="rs-wrap" ref={boxRef}>
        <button
          className={`tb-btn tb-reasoning rs-toggle rs-${on ? 'on' : 'off'}`}
          aria-label="思考开关"
          title={title}
          onClick={() => void patch({ reasoning: { ...rs, enabled: !on } })}
        >
          思考 {on ? '开' : '关'}
        </button>
      </div>
    )
  }

  const applyBudget = async (): Promise<void> => {
    const n = Number(draftBudget)
    if (draftBudget.trim() === '' || !Number.isFinite(n) || n < 0) return
    await patch({ reasoning: { ...rs, budget: n } })
    setDraftBudget('')
    setOpen(false)
  }

  // budget_tokens：数字框（R15）。预算字段未声明 ⇒ 预算发不出去，照实说
  if (rs.kind === 'budget_tokens') {
    const budget = rs.budget ?? 0
    const unspoken = !isAnthropic && !rs.budgetEncoding
    const unspokenNote = '未声明预算字段：OpenAI 兼容端点不会发送该预算。'
    const title = [
      budget > 0 ? `思考预算 ${budget} tokens。` : '尚未设置思考预算。',
      unspoken ? unspokenNote : '',
      anthropicNote
    ]
      .filter(Boolean)
      .join('\n')
    return (
      <div className="rs-wrap" ref={boxRef}>
        <button
          className="tb-btn tb-reasoning rs-budget"
          aria-label="思考预算"
          title={title}
          onClick={() => setOpen((v) => !v)}
        >
          思考预算 {budget > 0 ? formatTokens(budget) : '未设'}
          <span className="tb-caret">▾</span>
        </button>
        {open && (
          <div className="tb-menu">
            {unspoken && <p className="rs-note">{unspokenNote}</p>}
            <div className="rs-budget-row">
              <input
                type="number"
                min="0"
                aria-label="思考预算值"
                value={draftBudget}
                placeholder={budget > 0 ? String(budget) : '输入预算'}
                onChange={(e) => setDraftBudget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyBudget()
                }}
              />
              <button onClick={() => void applyBudget()}>应用</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // effort：档名单元
  const effort = entry.settings?.reasoningEffort ?? 'default'
  const levels = sortEffortLevels(rs.levels ?? [...KNOWN_EFFORT_LEVELS])
  const effective = effortToSend({ reasoningEffort: effort, reasoning: rs }) !== null
  const notSent = effort !== 'default' && !effective
  const title = [
    effort === 'default' ? '思考档位：默认（不发送思考字段）。' : `思考档位：${effort}。下一轮请求起生效。`,
    !rs.levels ? '未实测：该模型未声明支持的档位。' : '',
    notSent ? '该档不会发往厂商（不在声明的档位里）。' : '',
    anthropicNote
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className="rs-wrap" ref={boxRef}>
      <button
        className="tb-btn tb-reasoning rs-effort"
        aria-label="思考档位"
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        思考 {effort === 'default' ? '默认' : effort}
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="tb-menu">
          {!rs.levels && <p className="rs-note">未实测：该模型未声明支持的档位。</p>}
          <button
            className={`tb-menu-item ${effort === 'default' ? 'active' : ''}`}
            onClick={() => {
              void patch({ reasoningEffort: 'default' })
              setOpen(false)
            }}
          >
            <span className="tb-menu-title">默认</span>
            <span className="tb-menu-desc">不发送思考字段</span>
          </button>
          {levels.map((l) => (
            <button
              key={l}
              className={`tb-menu-item ${effort === l ? 'active' : ''}`}
              onClick={() => {
                void patch({ reasoningEffort: l })
                setOpen(false)
              }}
            >
              <span className="tb-menu-title">{l}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 上下文窗口常用值（R3）。「填个大概」走这里；精确值走自定义输入。 */
const CONTEXT_WINDOW_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '32k', value: 32768 },
  { label: '64k', value: 65536 },
  { label: '128k', value: 131072 },
  { label: '256k', value: 262144 },
  { label: '1M', value: 1048576 }
]

/**
 * 上下文窗口 chip（plan58 片③ R3）：已用 / 窗口两数 + 几档常用值 + 自定义。
 * ⚠️ 窗口是**客户端元数据**（不发厂商）—— 改它只影响 ContextRing 的分母与裁剪阈值，
 * 与缺陷 3 那四套「上下文长度」语义里的②③④无关，不许塞进同一个控件。
 */
export function ContextChip({ used }: { used: number }): JSX.Element | null {
  const { setModels, active, entry } = useActiveModelEntry()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 条目没单独设过 ⇒ 回落到 settings 视图（getSettingsView 合成的那份）。⚠️ hook 必须在早退之前
  const storeWindow = useAppStore((s) => s.settings?.contextWindow)
  if (!active || !entry) return null
  const window_ = entry.settings?.contextWindow
  const current = window_ ?? storeWindow ?? 0

  const apply = async (value: number): Promise<void> => {
    if (!Number.isFinite(value) || value <= 0) return
    const view = await window.api.patchModelEntry({
      profileId: active.id,
      entryId: entry.id,
      patch: { contextWindow: value }
    })
    setModels(view)
    setOpen(false)
  }

  return (
    <div className="rs-wrap" ref={boxRef}>
      <button
        className="tb-btn tb-reasoning ctx-chip"
        aria-label="上下文窗口"
        title={`上下文窗口：${current > 0 ? formatTokens(current) : '未设置'}。影响本地裁剪与压缩阈值，不发送厂商。`}
        onClick={() => setOpen((v) => !v)}
      >
        窗口 {current > 0 ? formatTokens(current) : '未设'}
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="tb-menu">
          <p className="rs-note">
            本会话已用约 {formatTokens(used)} tokens；窗口为本地元数据，不发送厂商。
          </p>
          <div className="rs-budget-row ctx-presets">
            {CONTEXT_WINDOW_PRESETS.map((p) => (
              <button
                key={p.value}
                className={current === p.value ? 'active' : ''}
                aria-label={`窗口 ${p.label}`}
                onClick={() => void apply(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="rs-budget-row">
            <input
              type="number"
              min="1000"
              aria-label="上下文窗口值"
              value={draft}
              placeholder="自定义 Token 数"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void apply(Number(draft))
              }}
            />
            <button onClick={() => void apply(Number(draft))}>应用</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Git 分支显示（只读；切换分支等操作属右抽屉「源代码管理」后续批次） */export function BranchChip(): JSX.Element | null {
  const [git, setGit] = useState<GitInfo | null>(null)
  const wsPath = useAppStore((s) => s.workspacePath)

  useEffect(() => {
    void window.api.getGitInfo().then(setGit)
  }, [wsPath])

  if (!git) return null
  return (
    <span className="tb-btn tb-branch" title={`Git 分支：${git.branch}${git.dirty ? '（存在未提交的改动）' : ''}`}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 3v7a3 3 0 0 0 3 3h2M4 3a1.6 1.6 0 1 1 0 3.2A1.6 1.6 0 0 1 4 3Zm7 0a1.6 1.6 0 1 1 0 3.2A1.6 1.6 0 0 1 11 3Zm0 3.2v2.4a3 3 0 0 1-3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
      {git.branch}
      {git.dirty && <span className="branch-dot" />}
    </span>
  )
}

/** 提示词优化（一次额外的轻量模型调用） */
export function PolishButton({
  text,
  onPolished
}: {
  text: string
  onPolished: (next: string) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      onPolished(await window.api.polishPrompt(text))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className={`tb-btn tb-icon ${busy ? 'busy' : ''}`}
      title={error ?? '优化提示词'}
      disabled={busy || !text.trim()}
      onClick={() => void run()}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 2l1.2 3.3L12.5 6.5 9.2 7.7 8 11 6.8 7.7 3.5 6.5l3.3-1.2L8 2Z"
          fill="currentColor"
        />
        <path d="M12.5 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z" fill="currentColor" />
      </svg>
    </button>
  )
}

export function SendButton({
  disabled,
  busy,
  onSend,
  onStop
}: {
  disabled: boolean
  busy: boolean
  onSend: () => void
  onStop: () => void
}): JSX.Element {
  if (busy) {
    return (
      <button className="send-btn stopping" title="停止生成" onClick={onStop}>
        <span className="stop-square" />
      </button>
    )
  }
  return (
    <button className="send-btn" title="发送（Enter）" disabled={disabled} onClick={onSend}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 3.5 11.5 8 5 12.5V3.5Z" fill="currentColor" />
      </svg>
    </button>
  )
}
