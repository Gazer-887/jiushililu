import { useEffect, useRef, useState } from 'react'
import type { RuntimeEntry } from '@shared/dev-env'

interface Props {
  /** 已证明来源的 + 「其他」两档 */
  main: RuntimeEntry[]
  others: RuntimeEntry[]
  /** 语言显示名（Node.js / Python） */
  langLabel: string
  /** 当前选中的 path；不在列表里 = 失效态仍要显示 */
  value: string
  stale: boolean
  onChange: (path: string) => void
  disabled: boolean
}

/**
 * 运行时下拉（plan43 风险 3）：原生 `<select>` 渲染不了"名称+版本 / 完整路径"双行，
 * 新建这个轻量弹层。折叠不等于隐藏：「其他」在弹层内可展开、可选。
 */
export default function RuntimeSelect({ main, others, langLabel, value, stale, onChange, disabled }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [showOthers, setShowOthers] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const all = [...main, ...others]
  const current = all.find((r) => r.path === value)
  const label = current
    ? `${langLabel} ${current.version}`.trim() + (current.alias ? ` ('${current.alias}')` : '')
    : value.length > 0
      ? value
      : '（未选择）'

  const item = (r: RuntimeEntry): React.ReactElement => (
    <button
      key={r.path}
      type="button"
      className={`rs-item${r.path === value ? ' is-on' : ''}`}
      onClick={() => {
        onChange(r.path)
        setOpen(false)
      }}
    >
      <span className="rs-item-name">
        {langLabel} {r.version.length > 0 ? r.version : ''}
        {r.alias ? ` ('${r.alias}')` : ''}
      </span>
      <span className="rs-item-path">{r.path}</span>
      {r.path === value && <span className="rs-item-check">✓</span>}
    </button>
  )

  return (
    <div className="rs" ref={boxRef}>
      <button
        type="button"
        className={`rs-trigger${stale ? ' is-stale' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={value}
      >
        {label}
        {stale && <span className="rs-stale-tag">已失效</span>}
        <span className="rs-caret">▾</span>
      </button>
      {open && (
        <div className="rs-pop" role="listbox">
          {main.map(item)}
          {others.length > 0 && (
            <>
              <button type="button" className="rs-others-toggle" onClick={() => setShowOthers((s) => !s)}>
                {showOthers ? '▾' : '▸'} 其他（{others.length}）
              </button>
              {showOthers && others.map(item)}
            </>
          )}
          {main.length === 0 && others.length === 0 && <div className="rs-empty">未检测到，请刷新</div>}
        </div>
      )}
    </div>
  )
}
