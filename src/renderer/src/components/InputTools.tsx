import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'

// 上下文用量指示器（P2）：按与主进程相同的估算口径显示"已用 / 上限"。
// 越过 75% 变黄、90% 变红——与主进程的裁剪阈值（0.75）呼应，让"要开始折叠历史"看得见。

const WARN = 0.75
const DANGER = 0.9

export function ContextMeter({ used }: { used: number }): JSX.Element {
  const limit = useAppStore((s) => s.settings?.contextWindow ?? 0)
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const level = ratio >= DANGER ? 'danger' : ratio >= WARN ? 'warn' : 'ok'
  const pct = limit > 0 ? Math.round(ratio * 100) : 0

  return (
    <div className={`ctx-meter ctx-${level}`} title={`上下文用量约 ${used} / ${limit || '未设置'} tokens`}>
      <div className="ctx-track">
        <div className="ctx-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-text">
        {limit > 0 ? `${pct}%` : '上下文未设置'}
      </span>
      {ratio >= WARN && <span className="ctx-hint">{ratio >= DANGER ? '即将折叠' : '接近上限'}</span>}
    </div>
  )
}

// 模型快速切换（P2）：下拉列出当前模型 + 最近用过的模型，也可直接输入新名字。
// 只改 model 字段——接口地址、Key、采样参数一律不动。

export function ModelSwitcher(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('recentModels')
      if (raw) setRecent((JSON.parse(raw) as string[]).slice(0, 6))
    } catch {
      // 本地记录损坏不影响主流程
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const apply = async (model: string): Promise<void> => {
    const name = model.trim()
    if (!name) return
    await window.api.setModel(name)
    await loadSettings()
    const next = [name, ...recent.filter((m) => m !== name)].slice(0, 6)
    setRecent(next)
    window.localStorage.setItem('recentModels', JSON.stringify(next))
    setDraft('')
    setOpen(false)
  }

  const options = useMemo(() => {
    const cur = settings?.model ?? ''
    return [cur, ...recent.filter((m) => m && m !== cur)].filter(Boolean)
  }, [settings?.model, recent])

  return (
    <div className="model-switch" ref={boxRef}>
      <button className="model-btn" onClick={() => setOpen((v) => !v)} title="切换模型">
        {settings?.model || '未配置模型'}
        <span className="model-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          {options.map((m) => (
            <button
              key={m}
              className={`model-item ${m === settings?.model ? 'active' : ''}`}
              onClick={() => void apply(m)}
            >
              {m}
            </button>
          ))}
          <div className="model-new">
            <input
              value={draft}
              placeholder="输入模型名后回车"
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
