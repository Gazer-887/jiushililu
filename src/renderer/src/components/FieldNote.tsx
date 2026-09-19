import { useEffect, useRef, type ReactNode } from 'react'

/** 气泡与记号的缝隙，与 styles.css 里 `var(--sp-8)` 同值 —— 改那侧要同步这里 */
const GAP_PX = 8
/** 两侧都放不下时的限高下界：再矮也留一截可读的窗口，不塌成零高 */
const MIN_H_PX = 48

/**
 * 裁切祖先：第一个 `overflow-y` 会裁切内容（auto / scroll / hidden）的祖先。
 * 不写死 `.settings-body` —— FieldNote 同时被记忆页、手册页用着，那边的容器不是设置页。
 */
function clipHost(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = window.getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') return p
  }
  return document.documentElement
}

/**
 * **文案注释层**（2026-09-13 用户定调）：把长篇说明收进一个 `ⓘ` 记号，悬停/聚焦才展开。
 *
 * 起因：通用设置页的「省 token 档位」等段落，注释长到挤占拖放视觉与布局 ——
 * 而设置页的每条说明**都要留着**（它们是"设了不等于生效"那类坑的防线），不能删，只能收。
 * 2026-09-14 用户定调扩大收取范围：选项卡副说明、组级说明段全部收进 ⓘ（组级一个，气泡内分条）。
 *
 * 三条设计约束：
 * ① **展开靠 CSS 兄弟选择器，不做 JS 弹层** —— 不引库、不用 state。设置项动辄十几个，
 *    每处挂一份弹层不值当；且悬停行为不该引发 React 重渲染。
 *    2026-09-20 用户裁决（H4-①）**有意破一半、保住另一半**：纯 CSS 定不出"哪一侧放得下"，
 *    而 0.13.41 那次把气泡从"向上弹"改成"向下弹"只是把裁切从顶部搬到下缘 —— 于是边界判定
 *    交给极少量命令式 DOM（只 useRef + classList / style 赋值，悬停仍不触发重渲染）；
 *    CSS 那条 `:hover +` 规则不动，关掉 JS 时退回"向下弹"的现状而不是气泡消失。
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
  /** 单段说明；传数组 = 气泡内**分条**显示（每条一行）—— 组级 ⓘ 汇总多个选项说明时用 */
  text: string | string[]
  kind?: 'info' | 'warn'
  side?: 'left' | 'right'
  /** 不传则用默认记号字符 */
  children?: ReactNode
}): JSX.Element {
  const noteRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const items = Array.isArray(text) ? text : [text]
  const mark = children ?? (kind === 'warn' ? '!' : 'i')

  /** 气泡自然高度：CSS 让它只在悬停/聚焦时显示，脚本量到时可能还是 `display:none`（高度 0）——
   *  那种情况临时显形量一次再交回 CSS，否则边界判定拿到 0 就等于没判。 */
  const naturalHeight = (bubble: HTMLElement): number => {
    const shown = bubble.getBoundingClientRect().height
    if (shown > 0) return shown
    const prev = bubble.style.display
    bubble.style.display = 'block'
    const h = bubble.getBoundingClientRect().height
    bubble.style.display = prev
    return h
  }

  /** 收起时清掉一次性痕迹，免得下一次在别处展开时沿用上一个位置的判定结果 */
  const reset = (): void => {
    const bubble = bubbleRef.current
    if (!bubble) return
    bubble.classList.remove('fnote-flip-up')
    bubble.style.maxHeight = ''
  }

  /** 出气泡前定方向：默认向下弹，仅当下缘越出裁切祖先才翻成向上；翻转后上方仍不够就收缩限高，
   *  交给 CSS 的 `overflow-y:auto` 内滚（矮窗口真实存在 —— 设置窗不许最大化但能缩得很小）。 */
  const place = (): void => {
    const note = noteRef.current
    const bubble = bubbleRef.current
    if (!note || !bubble) return
    // 先清成 CSS 默认再量：悬停与聚焦会先后各触发一次，带着上一次的限高去量会把自然高度量小、判错方向
    reset()
    const hr = clipHost(note).getBoundingClientRect()
    const nr = note.getBoundingClientRect()
    const h = naturalHeight(bubble)
    const below = hr.bottom - nr.bottom - GAP_PX
    const above = nr.top - hr.top - GAP_PX
    let flip = false
    // null = 不干预限高；数值 = 把气泡压到该侧的实际可用高度（内滚读完剩下的）
    let cap: number | null = null
    if (h > below) {
      if (h > above) {
        // 两侧都塞不下完整气泡 → 挑宽裕的一侧，并收缩限高
        flip = above >= below
        cap = Math.round(flip ? above : below)
      } else flip = true
    }
    bubble.classList.toggle('fnote-flip-up', flip)
    bubble.style.maxHeight = cap === null ? '' : `${Math.max(cap, MIN_H_PX)}px`
  }

  /** 滚动时重算朝向：记号跟着内容平移，只在 mouseenter 那一刻判定一次的话，
   *  用户滚到底部时气泡会**重新越界**（problem.md 09-15「接力注意」点名要连抖动感一起验 ——
   *  抖动的实质就是"要看还得滚动，一滚它又跑出可视区"）。
   *  ⚠️ 刻意不把 place 放进依赖数组：那样每次渲染都会重挂监听，正是 plan49 L1 那个
   *  「内联回调 → effect 重跑」自持闭环的形状。用 ref 转发，监听只挂一次。
   *  ⚠️ 也刻意不用 state 表达"是否在滚动"：约束①保住的那一半是"悬停/滚动不引发重渲染"。 */
  const placeRef = useRef(place)
  placeRef.current = place
  useEffect(() => {
    const note = noteRef.current
    if (!note) return
    const host = clipHost(note)
    const onScroll = (): void => {
      const bubble = bubbleRef.current
      // 没在显示就不动它：否则滚动会替用户"预支"一次展开
      if (!bubble || bubble.getBoundingClientRect().height === 0) return
      place()
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => host.removeEventListener('scroll', onScroll)
    // 空依赖：监听只挂一次（place 走 ref 转发，见上方注释）
  }, [])

  return (
    <span ref={noteRef} className={side === 'left' ? 'fnote fnote-left' : 'fnote'}>
      <span
        className={`fnote-mark fnote-mark-${kind}`}
        // tabIndex 让它可聚焦 —— 键盘用户按 Tab 也能读到说明（只靠 :hover 会把键盘挡在外面）
        tabIndex={0}
        role="note"
        aria-label={items.join('；')}
        onMouseEnter={place}
        onMouseLeave={reset}
        onFocus={place}
        onBlur={reset}
      >
        {mark}
      </span>
      <span ref={bubbleRef} className="fnote-bubble" role="tooltip">
        {items.map((line, i) => (
          <span key={i} className="fnote-line">
            {line}
          </span>
        ))}
      </span>
    </span>
  )
}
