import type { ReactNode } from 'react'

/**
 * **文案注释层**（2026-09-13 用户定调）：把长篇说明收进一个 `ⓘ` 记号，悬停/聚焦才展开。
 *
 * 起因：通用设置页的「省 token 档位」等段落，注释长到挤占拖放视觉与布局 ——
 * 而设置页的每条说明**都要留着**（它们是"设了不等于生效"那类坑的防线），不能删，只能收。
 *
 * 三条设计约束：
 * ① **纯 CSS 出气泡** —— 不引库、不用 state。设置项动辄十几个，每处挂一份 JS 弹层不值当；
 *    且悬停行为不该引发 React 重渲染。
 * ② **键盘可达** —— 只做 `:hover` 等于把键盘用户挡在外面；故挂 `tabIndex` 并用 `:focus-visible` 同样展开。
 *    无障碍不是加一个 `title` 就交差（`title` 无法聚焦、样式也不可控）。
 * ③ **不做成 modal** —— 它是"补充说明"，不该抢焦点、不该拦交互。`role="note"` + 可聚焦即够。
 *
 * ⚠️ 气泡**宽度固定**（不是 `max-width: max-content`）：长句在窄屏上会撑出视口，
 * 而设置页右栏本来就窄。定宽 + 自动换行是唯一在各档宽度下都不溢出画布的做法。
 */
export default function FieldNote({
  text,
  /** 记号形态：`info` = ⓘ（补充说明）· `warn` = ！（有代价 / 有坑） */
  kind = 'info',
  /** 记号出现在标签的哪一侧。默认右侧（`省 token 档位 ⓘ` 这种读法） */
  side = 'right',
  children
}: {
  text: string
  kind?: 'info' | 'warn'
  side?: 'left' | 'right'
  /** 不传则用默认记号字符 */
  children?: ReactNode
}): JSX.Element {
  const mark = children ?? (kind === 'warn' ? '!' : 'i')
  return (
    <span className={side === 'left' ? 'fnote fnote-left' : 'fnote'}>
      <span
        className={`fnote-mark fnote-mark-${kind}`}
        // tabIndex 让它可聚焦 —— 键盘用户按 Tab 也能读到说明（只靠 :hover 会把键盘挡在外面）
        tabIndex={0}
        role="note"
        aria-label={text}
      >
        {mark}
      </span>
      <span className="fnote-bubble" role="tooltip">
        {text}
      </span>
    </span>
  )
}
