import { useCallback, useEffect, useRef, useState } from 'react'
import { computeWidth, type UIPrefs } from '@shared/splitter'

// 可拖拽分隔条（plan7 批 A0）
//
// 用法：放在两个区域之间，拖动即改相邻区域宽度；**双击复位**为默认宽度。
//
// 三个实现要点（都是踩过才知道的）：
//   ① 监听挂在 **document** 上，不是手柄上 —— 否则鼠标拖快了离开手柄就断了
//   ② 拖拽期间给 body 加 `data-resizing`，关掉宽度的 CSS transition ——
//      否则宽度会"追"着鼠标走，手感像卡了半拍（.sidebar/.dock 都带 0.16s 过渡）
//   ③ 只在 **mouseup 时**持久化一次 —— 拖动过程中每帧写盘太浪费

export interface SplitterProps {
  side: 'left' | 'right'
  min: number
  max: number
  /** 当前宽度（受控：由父级 store 持有） */
  width: number
  onResize: (width: number) => void
  /** 松手时调用（真正落盘） */
  onCommit: (patch: Partial<UIPrefs>) => void
  onReset: () => void
  label: string
}

export default function Splitter(props: SplitterProps): JSX.Element {
  const { side, min, max, width, onResize, onCommit, onReset, label } = props
  const [dragging, setDragging] = useState(false)
  // 用 ref 记住"当前宽度"，避免拖拽回调闭包拿到旧值
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
        // 容器 = 整个应用主体（左抽屉 + 主区域 + 右抽屉）
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
        // 松手才落盘（拖动过程中每帧写盘是浪费）
        if (side === 'left') onCommit({ sidebarWidth: latest.current })
        else onCommit({ dockWidth: latest.current })
        stop()
      }

      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [side, min, max, onResize, onCommit, stop]
  )

  // 组件卸载时兜底清理（例如拖拽中被切换到别的视图）
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
