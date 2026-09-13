import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { sourceLabel, type ModelsView } from '@shared/models'
import { cacheHitRate, formatRate, formatTokens, reasoningShare, totalTokens } from '@shared/usage'
import { tierLabel } from '@shared/token-tier'
import type { GitInfo, PermissionPreset } from '@shared/ipc'

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
      title={limit > 0 ? `上下文用量约 ${used} / ${limit} tokens` : '上下文窗口未设置（去设置页填写）'}
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
  if (!record) return null

  const { total, last, avoided } = record
  /**
   * 命中率与思考占比（plan8 R9.1）。`null` = **厂商没报这个数** → 什么都不显示（连 0% 都不写，
   * 写 0% 等于替厂商宣布"一点没命中"）。但 `思考 0%` 会出现：厂商明确报了 0 就是事实，该显示。
   * 这两种 0 走两条路，见 @shared/usage。
   */
  const hit = cacheHitRate(total)
  const think = reasoningShare(total)
  const tip = [
    `本会话累计（厂商真实值）：${totalTokens(total)} tokens`,
    `输入 ${formatTokens(total.promptTokens)} · 输出 ${formatTokens(total.completionTokens)}`,
    hit !== null
      ? `其中前缀缓存命中：${formatTokens(total.cachedPromptTokens ?? 0)}（${formatRate(hit)}）`
      : '前缀缓存命中：厂商未报',
    think !== null
      ? `输出里推理（思考）：${formatTokens(total.reasoningTokens ?? 0)}（${formatRate(think)}）`
      : '输出里推理（思考）：厂商未报',
    last ? `最近一轮：${totalTokens(last)} tokens` : '',
    // 记下"这轮是哪一档跑的" —— 用户比数字时得知道它的出处（plan8 §七②）
    record.tier ? `省 token 档位（设置页可改）：${tierLabel(record.tier)}` : '',
    // ⚠️ 这行必须**说清是估算**：它与上面的"厂商真实值"不同源，不说清用户没法判断哪个数能信。
    avoided > 0 ? `工具输出成形省下（本地估算）：约 ${formatTokens(avoided)} tokens` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className="usage-chip" title={tip}>
      <span className="usage-total">{formatTokens(totalTokens(total))}</span>
      <span className="usage-unit">tok</span>
      {last && <span className="usage-last">+{formatTokens(totalTokens(last))}</span>}
      {hit !== null && <span className="usage-rate">命中 {formatRate(hit)}</span>}
      {think !== null && <span className="usage-rate">思考 {formatRate(think)}</span>}
      {/* 主进程没带这个字段就**不显示** —— 不替它编一个默认档 */}
      {record.tier && <span className="usage-tier">{tierLabel(record.tier)}</span>}
      {avoided > 0 && <span className="usage-saved">省 {formatTokens(avoided)}</span>}
    </span>
  )
}

/**
 * 模型快速切换（plan7 F5 之后）：**切的是档案，不是名字**（数据与设置页同一份 `models:list`）。
 * 不靠手输模型名 —— 多模型下光改名字 = 拿新名字去撞**当前那条连接**，多半 400；
 * 换模型去设置页「添加模型」，这里的手输只留给"同一条连接上换个模型名"。
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

  /** 切档案：主进程切完之后，各处读的都是"当前档案"，拉一次即同步 */
  const useProfile = async (id: string): Promise<void> => {
    const next = await window.api.setActiveModel(id)
    setModels(next)
    await loadSettings()
    setOpen(false)
  }

  /** 同一条连接上换模型名（厂商改名、临时试新模型等少数情况） */
  const apply = async (model: string): Promise<void> => {
    const name = model.trim()
    if (!name) return
    await window.api.setModel(name)
    await loadSettings()
    setDraft('')
    setOpen(false)
  }

  const active = models?.profiles.find((p) => p.id === models.activeId) ?? null
  const label = active?.name ?? settings?.model ?? '未配置模型'

  return (
    <div className="model-switch" ref={boxRef}>
      <button className="tb-btn tb-model" onClick={() => setOpen((v) => !v)} title="切换模型">
        {label}
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          {models && models.profiles.length > 0 ? (
            models.profiles.map((p) => (
              <button
                key={p.id}
                className={`model-item ${p.id === models.activeId ? 'active' : ''}`}
                onClick={() => void useProfile(p.id)}
                title={p.models.map((m) => m.model).join('、')}
              >
                {p.name}
                <span className="model-item-src">{sourceLabel(p.source)}</span>
              </button>
            ))
          ) : (
            <button className="model-item" onClick={() => setOpen(false)}>
              {settings?.model || '还没配模型'}
              <span className="model-item-src">去设置页添加</span>
            </button>
          )}
          <div className="model-new">
            <input
              value={draft}
              placeholder="同一条连接上换个模型名，回车"
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
  'read-only': '模型只能读取，不能修改任何文件',
  write: '可读写工作区内文件；命令执行仍需显式授权',
  'full-access': '含命令执行，不再逐次确认（谨慎使用）'
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

/** Git 分支显示（只读；切换分支等操作属右抽屉「源代码管理」后续批次） */
export function BranchChip(): JSX.Element | null {
  const [git, setGit] = useState<GitInfo | null>(null)
  const wsPath = useAppStore((s) => s.workspacePath)

  useEffect(() => {
    void window.api.getGitInfo().then(setGit)
  }, [wsPath])

  if (!git) return null
  return (
    <span className="tb-btn tb-branch" title={`Git 分支：${git.branch}${git.dirty ? '（有未提交改动）' : ''}`}>
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
      title={error ?? '优化提示词（把草稿改写得更清晰）'}
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
