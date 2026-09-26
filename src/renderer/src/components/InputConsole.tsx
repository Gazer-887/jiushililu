import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Attachment, SkillInfo } from '@shared/ipc'
import { DRAG_PATH_MIME } from '@shared/fs-tree'
import PlusMenu from './PlusMenu'
import WorkspaceChip from './WorkspaceChip'
import { BranchChip, ContextRing, ModelSwitcher, PermissionChip, PolishButton, SendButton, UsageChip } from './InputTools'
import VoiceButton from './VoiceButton'

// 输入控制台（P2，D-032）：与「这一次请求」有关的设置都收在这里 —— 视线不用来回跑。
// 拖拽落点的挂载规则见 `dropZone` 与 `takeDrop`：整套只许有一处挂载。

export interface InputConsoleProps {
  value: string
  onChange: (v: string) => void
  /** 提交（附件由内部管理，一并通过回调交出） */
  onSubmit: (attachments: Attachment[]) => void
  busy?: boolean
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  usedTokens: number
  /** 当前选中的主 Agent（plan17）；undefined = 不显示选择区 */
  selectedAgent?: string | null
  onSelectAgent?: (name: string | null) => void
  /** 只在**新建任务页**为 true —— 会话一创建就绑定工作区，对话页再放是冗余（D-035） */
  showWorkspace?: boolean
  /**
   * 拖拽落点范围。不传就只有输入框自己能接 ——「拖进会话」的"会话"是**整块对话区**，
   * 用户不会瞄着一个框去放。传进来的容器接管整个区域的 dragover/dragleave/drop。
   */
  dropZone?: RefObject<HTMLElement>
}

/** 决定"这块区域要不要当落点" */
function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  // `Files` = 系统资源管理器拖来的，自定义 MIME = 工作区文件树拖来的。
  // 其余（如在对话里拖选一段文字）**不该**当落点 —— 否则浏览器既插入文字又提示"没收到文件路径"。
  return dt.types.includes(DRAG_PATH_MIME) || dt.types.includes('Files')
}

/** 剥掉 Electron 包装的那层壳（`Error invoking remote method '…': Error: `）—— 它对用户没有意义 */
function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

export default function InputConsole({
  value,
  onChange,
  onSubmit,
  busy = false,
  onStop,
  placeholder = '输入消息，Enter 发送，Shift+Enter 换行',
  autoFocus = false,
  usedTokens,
  selectedAgent,
  onSelectAgent,
  showWorkspace = false,
  dropZone
}: InputConsoleProps): JSX.Element {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  /** 落点高亮 —— 不亮用户不知道这里能放 */
  const [dragging, setDragging] = useState(false)

  // ── plan34 S4：「/」光标处技能浮层 ── 只列**开启的**技能（实时与设置页一致，skillsChanged 驱动）。
  // 触发：光标前的 token 以 / 开头且 / 在行首或空白后（防 URL 误触）。↑↓ 选择、Enter/Tab 插入、Esc 关。
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])

  useEffect(() => {
    const pull = (): void => {
      void window.api.listSkills().then(async (list) => {
        const disabled = await window.api.getSkillsDisabled()
        setSlashSkills(list.filter((s) => !disabled.includes(s.name) && !s.overridden))
      })
    }
    pull()
    return window.api.onSkillsChanged(pull)
  }, [])

  const slashMatches = slash ? slashSkills.filter((s) => s.name.startsWith(slash.query)) : []

  const handleChange = (next: string): void => {
    onChange(next)
    const ta = taRef.current
    if (!ta) {
      setSlash(null)
      return
    }
    const pos = ta.selectionStart
    const lineStart = next.lastIndexOf('\n', pos - 1) + 1
    const m = /(^|\s)(\/[\w-]*)$/.exec(next.slice(lineStart, pos))
    setSlash(m ? { start: pos - m[2].length, query: m[2].slice(1) } : null)
    setSlashIdx(0)
  }

  const pickSlash = (name: string): void => {
    if (!slash) return
    const insert = `请使用技能 ${name}：`
    const next = value.slice(0, slash.start) + insert + value.slice(slash.start + 1 + slash.query.length)
    onChange(next)
    setSlash(null)
    const caret = slash.start + insert.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(caret, caret)
      }
    })
  }

  // 附件只在成功提交时清空（busy 由真转假时保留），见 submit
  useEffect(() => {
    if (!attachError) return
    const t = setTimeout(() => setAttachError(null), 4000)
    return () => clearTimeout(t)
  }, [attachError])

  /**
   * ⚠️ 必须 `useCallback`（plan49 L1 同源修复）：它被传给 `PlusMenu` 的 `onAttach`，
   * 而本次卡顿的病根就是"传给 PlusMenu 的回调每次渲染换新引用"。目前 `PlusMenu` 的
   * effect 只依赖 `[open]`、没依赖 `onAttach`，所以这条**暂时**不构成闭环 ——
   * 但只要有人以后给 `onAttach` 加一处 effect 依赖，立刻复发（实测拦在
   * `tests/unit/render-callback-stability.test.ts`）。依赖只有两个 setState（引用稳定），
   * 包起来零代价。
   */
  const addAttachment = useCallback(async (): Promise<void> => {
    try {
      const a = await window.api.attachFile()
      if (!a) return
      setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]))
    } catch (err) {
      setAttachError(cleanError(err))
    }
  }, [])

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((p) => p.path !== path))
  }

  /** 两个拖拽来源共用；去重规则与"选文件"那条一致 */
  const addByPath = async (pathOrRel: string): Promise<void> => {
    try {
      const a = await window.api.attachPath(pathOrRel)
      setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]))
    } catch (err) {
      // 越界（从系统拖了工作区外的文件）等情况在这里给明确理由 —— **不静默失败**
      setAttachError(cleanError(err))
    }
  }

  /**
   * 拖到会话里 → 变成附件。两个来源：工作区文件树（自定义 MIME 的相对路径）、
   * 系统资源管理器（`dataTransfer.files` + `webUtils.getPathForFile` —— Electron 32+ 已移除 `File.path`）。
   * 两者的读取与边界校验是同一份（主进程 `readAttachment`），故越界文件被拒的理由与"选文件"一致。
   */
  const takeDrop = async (dt: DataTransfer | null): Promise<void> => {
    if (!dt) return
    const rel = dt.getData(DRAG_PATH_MIME)
    if (rel) {
      await addByPath(rel)
      return
    }
    const files = Array.from(dt.files ?? [])
    if (files.length > 0) {
      for (const f of files) {
        const abs = window.api.getPathForFile(f)
        if (abs) await addByPath(abs)
      }
      return
    }
    // 认出来是文件拖拽，却**一个可用路径都没拿到** —— 这里必须说话。
    // 什么都不做 = 界面毫无反应 + 日志无痕，用户只能说"拖不进去"，排查时一条线索都没有。
    setAttachError('没收到文件路径：请拖入文件而非文件夹；从系统拖入时请确认所拖的是文件')
  }

  /**
   * 落点用**原生监听**，不用 React 的 onDrop：落点常是父组件的容器，而输入框就在容器里，
   * React 那套会在两处各收一次 → 一次拖拽加两遍附件。一处定义、一处挂载。
   */
  const [consoleEl, setConsoleEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    // `dropZone.current` 必须**在 effect 里读**：父容器的 ref 同一个 commit 才挂上，
    // 渲染期读拿到 null 且不触发重渲染 —— 监听就永远挂不上去。
    const el: HTMLElement | null = dropZone?.current ?? consoleEl
    if (!el) return

    const relevant = (ev: DragEvent): boolean => isFileDrag(ev.dataTransfer)
    const onOver = (ev: DragEvent): void => {
      if (!relevant(ev)) return
      // 必须 preventDefault —— 否则 drop **根本不会触发**
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const onLeave = (ev: DragEvent): void => {
      // 在子元素之间移动也会触发 dragleave —— 用 relatedTarget 判断是否真的离开了整块区域，否则高亮会闪
      if (ev.relatedTarget && el.contains(ev.relatedTarget as Node)) return
      setDragging(false)
    }
    const onDrop = (ev: DragEvent): void => {
      if (!relevant(ev)) return
      ev.preventDefault()
      setDragging(false)
      void takeDrop(ev.dataTransfer)
    }

    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
    }
    // 刻意**不留依赖数组**：处理函数要拿最新一次渲染的闭包（附件列表、落点元素），
    // 写死依赖就要引 useCallback，否则"闭包过期 → 拖进去的是上一轮附件"更难查。
  })

  const submit = (): void => {
    if (busy || (!value.trim() && attachments.length === 0)) return
    onSubmit(attachments)
    setAttachments([])
  }

  return (
    // 拖拽监听全在上面那段 effect 里，这里**不再挂 React 的 onDrop** —— 两套处理会让一次拖拽加两遍附件
    <div ref={setConsoleEl} className={`console ${dragging ? 'console-drop' : ''}`}>
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((a) => (
            <span key={a.path} className="attach-chip" title={`${a.path}${a.truncated ? '（内容已截断）' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 2h5l3 3v9H4V2Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              {a.name}
              {a.image && <span className="attach-kind">图片</span>}
              {a.outside && <span className="attach-out">工作区外</span>}
              {a.truncated && <span className="attach-trunc">截断</span>}
              <button className="attach-x" title="移除" onClick={() => removeAttachment(a.path)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {showWorkspace && (
        <div className="console-workspace">
          <WorkspaceChip />
        </div>
      )}

      {slash && slashMatches.length > 0 && (
        <div className="slash-menu" onMouseDown={(e) => e.preventDefault()}>
          <div className="plus-title">技能（↑↓ 选择，Enter 插入，Esc 关闭）</div>
          {slashMatches.map((s, i) => (
            <button key={s.name} className={`slash-item ${i === slashIdx ? 'on' : ''}`} onClick={() => pickSlash(s.name)}>
              <span className="plus-name">/{s.name}</span>
              <span className="plus-desc">{s.descriptionZh ?? s.description}</span>
            </button>
          ))}
        </div>
      )}

      <textarea
        className="console-input"
        ref={taRef}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (slash && slashMatches.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSlashIdx((i) => (i + 1) % slashMatches.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pickSlash(slashMatches[slashIdx].name)
              return
            }
            if (e.key === 'Escape') {
              setSlash(null)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />

      {attachError && <div className="console-error">{attachError}</div>}

      <div className="console-toolbar">
        {/* 左右各自成簇：换行时整组一起走，避免发送键独自掉到下一行 */}
        <div className="tb-group tb-left">
          <PlusMenu
            selectedAgent={selectedAgent ?? null}
            {...(onSelectAgent ? { onSelectAgent } : {})}
            onAttach={addAttachment}
          />
          <BranchChip />
          <PermissionChip />
        </div>

        <div className="tb-group tb-right">
          <ContextRing used={usedTokens} />
          <UsageChip />
          <VoiceButton textareaEl={() => taRef.current} getText={() => value} onInsert={(next) => onChange(next)} />
          <PolishButton text={value} onPolished={(next) => onChange(next)} />
          <ModelSwitcher />
          <SendButton
            disabled={busy || (!value.trim() && attachments.length === 0)}
            busy={busy}
            onSend={submit}
            onStop={() => onStop?.()}
          />
        </div>
      </div>
    </div>
  )
}
