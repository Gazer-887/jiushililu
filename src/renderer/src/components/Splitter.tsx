import { useCallback, useEffect, useRef, useState } from 'react'
import { computeWidth, type UIPrefs } from '@shared/splitter'

// 可拖拽分隔条（plan7 批 A0）：放在两个区域之间，拖动改相邻区域宽度，**双击复位**。
// 三个要点（都是踩过才知道的）：
// ① 监听挂 **document**、不挂手柄 —— 鼠标拖快了离开手柄就断，拖拽会中途失效
// ② 拖拽期间给 body 加 `data-resizing` 关掉宽度过渡 —— 否则宽度"追"着鼠标走，手感像卡半拍
// ③ 只在 **mouseup 时**持久化一次 —— 拖动过程中每帧写盘太浪费

export interface SplitterProps {
  side: 'left' | 'right'
  min: number
  max: number
  /** 受控宽度：由父级 store 持有 */
  width: number
  onResize: (width: number) => void
  /** 松手时调用（才真正落盘） */
  onCommit: (patch: Partial<UIPrefs>) => void
  onReset: () => void
  label: string
}

export default function Splitter(props: SplitterProps): JSX.Element {
  const { side, min, max, width, onResize, onCommit, onReset, label } = props
  const [dragging, setDragging] = useState(false)
  // ref 记当前宽度：拖拽回调的闭包会拿到旧值
  const latest = useRef(width)

  useEffect(() => {
    latest.current = width
  }, [width])

  const stop = useCallback(() => {
    setDragging(false)
    document.body.removeAttribute('data-resizing')
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      e.preventDefault() // 防止拖动时选中文字
      setDragging(true)
      document.body.setAttribute('data-resizing', side)

      const move = (ev: MouseEvent): void => {
        // 容器 = 整个应用主体（左右抽屉 + 主区域）
        const body = document.querySelector('.app-body') as HTMLElement | null
        if (!body) return
        const rect = body.getBoundingClientRect()
        const next = computeWidth({
          pointerX: ev.clientX,
          containerLeft: rect.left,
          containerRight: rect.right,
          side,
          min,
          max
        })
        if (next !== latest.current) onResize(next)
      }

      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        if (side === 'left') onCommit({ sidebarWidth: latest.current })
        else onCommit({ dockWidth: latest.current })
        stop()
      }

      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [side, min, max, onResize, onCommit, stop]
  )

  // 卸载兜底清理：拖拽过程中被切走视图也要收尾
  useEffect(() => stop, [stop])

  return (
    <div
      className={`splitter ${dragging ? 'splitter-active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`拖动调整宽度，双击复位（当前 ${width}px）`}
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
    />
  )
}
