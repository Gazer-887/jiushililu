import { useEffect, useState, type RefObject } from 'react'
import type { Attachment } from '@shared/ipc'
import { DRAG_PATH_MIME } from '@shared/fs-tree'
import PlusMenu from './PlusMenu'
import WorkspaceChip from './WorkspaceChip'
import { BranchChip, ContextRing, ModelSwitcher, PermissionChip, PolishButton, SendButton } from './InputTools'

// 输入控制台（P2，D-032 输入框控制台化）——对齐用户图纸：
//
//   ┌──────────────────────────────────────────┐
//   │ [附件 chip ×]                             │  ← 附件区（有附件才显示）
//   │                                           │
//   │ 输入消息，Enter 发送，Shift+Enter 换行       │  ← 多行输入区（自动撑高）
//   ├──────────────────────────────────────────┤
//   │ [＋] [⎇ 分支] [权限▾]   [◯进度] [✨] [模型▾] [▶] │  ← 工具栏
//   └──────────────────────────────────────────┘
//
// 设计：所有与"这一次请求"有关的设置都在这里面——视线不用来回跑。

export interface InputConsoleProps {
  value: string
  onChange: (v: string) => void
  /** 提交（附件由内部管理，一并通过回调交出） */
  onSubmit: (attachments: Attachment[]) => void
  busy?: boolean
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  /** 上下文用量（token） */
  usedTokens: number
  /** 技能勾选（新建任务页用；不传则 ＋ 菜单只提供附件） */
  pickedSkills?: string[]
  onToggleSkill?: (name: string) => void
  /**
   * 是否在工作区行显示「选择工作区」。
   * 只在**新建任务页**为 true——会话一旦创建就绑定了工作区，对话页再放是冗余（D-035）。
   */
  showWorkspace?: boolean
  /**
   * 拖拽落点的**范围**。不传就只有输入框自己能接。
   *
   * 「文件拖进会话」里的"会话"是**整块对话区**，用户不会瞄着一个框去放 ——
   * 0.13.2 用户报"拖不进去"之后改成整块都能接。
   * 传进来的容器会接管整个区域的 dragover/dragleave/drop，输入框只负责亮起来。
   */
  dropZone?: RefObject<HTMLElement>
}

/** 这次拖拽带的是文件吗（决定"这块区域要不要当落点"） */
function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  // `Files` 是系统资源管理器拖来的；自定义 MIME 是工作区文件树拖来的。
  // 其余（比如在对话里拖选一段文字）**不该**被当成落点 —— 否则会让浏览器
  // 既插入文字又提示"没收到文件路径"，两边都错。
  return dt.types.includes(DRAG_PATH_MIME) || dt.types.includes('Files')
}

/**
 * Electron 会给主进程抛的错包一层壳：`Error invoking remote method 'attach:path': Error: …`。
 * 那层壳对用户没有任何意义（0.13.2 用户贴回来的报错就是这串），剥掉。
 */
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
  pickedSkills,
  onToggleSkill,
  showWorkspace = false,
  dropZone
}: InputConsoleProps): JSX.Element {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  /** 有东西正被拖到输入框上方（给个落点高亮，否则用户不知道这里能放） */
  const [dragging, setDragging] = useState(false)

  // 附件清空：新一轮提交后由父组件通过 key 变化重置不方便，这里在 busy 由真转假时保留，
  // 仅在成功提交时清（见 submit）
  useEffect(() => {
    if (!attachError) return
    const t = setTimeout(() => setAttachError(null), 4000)
    return () => clearTimeout(t)
  }, [attachError])

  const addAttachment = async (): Promise<void> => {
    try {
      const a = await window.api.attachFile()
      if (!a) return
      setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]))
    } catch (err) {
      setAttachError(cleanError(err))
    }
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((p) => p.path !== path))
  }

  /** 按路径加附件（两个拖拽来源共用；去重规则与"选文件"那条一致） */
  const addByPath = async (pathOrRel: string): Promise<void> => {
    try {
      const a = await window.api.attachPath(pathOrRel)
      setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]))
    } catch (err) {
      // 越界（从系统拖了工作区外的文件）等情况在这里给明确理由，**不静默失败**
      setAttachError(cleanError(err))
    }
  }

  /**
   * 拖到会话里 → 变成附件（plan7 批 A3 姊妹项：③ 文件拖进会话）。
   *
   * 两个来源分别处理：
   *   ① **工作区文件树**拖来的：带自定义 MIME 的相对路径
   *   ② **系统资源管理器**拖来的：`dataTransfer.files` + `webUtils.getPathForFile`
   *      （Electron 32+ 已移除 `File.path`，只能走这条路）
   *
   * 两者的**读取与边界校验是同一份**（主进程 `readAttachment`）——
   * 所以从系统拖一个工作区外的文件进来会被拒绝，且理由和"选文件"那条完全一致。
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
    // 之前是什么都不做：界面毫无反应、日志里也没有痕迹，用户只能说"拖不进去"，
    // 而排查的人（我）手上一条线索都没有。最糟的失败方式就是**静默失败**。
    setAttachError('没收到文件路径：请拖「文件」而不是文件夹；从系统拖进来时确认它真的是一个文件')
  }

  /**
   * 落点用**原生监听**而不是 React 的 onDrop：
   * 落点可能是父组件里的容器（整个会话区），而输入框自己就在那个容器里面 ——
   * React 那套会**同时**在输入框和容器上各收一次，一次拖拽加两遍附件。
   * 一处定义、一处挂载：拖拽的整个流程只有这一条路。
   */
  const [consoleEl, setConsoleEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    // 注意 dropZone.current 要**在 effect 里读**：父容器的 ref 是同一个 commit 里挂上的，
    // 渲染期读只会拿到 null，而 null 不会触发重渲染 —— 监听就永远挂不上去了。
    const el: HTMLElement | null = dropZone?.current ?? consoleEl
    if (!el) return

    const relevant = (ev: DragEvent): boolean => isFileDrag(ev.dataTransfer)
    const onOver = (ev: DragEvent): void => {
      if (!relevant(ev)) return
      // 必须 preventDefault：否则浏览器不认为这里是合法落点，`drop` **根本不会触发**
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const onLeave = (ev: DragEvent): void => {
      // 在子元素之间移动也会触发 dragleave —— 用 relatedTarget 判断是不是真的离开了整块区域，
      // 否则高亮会一直闪
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
    // 刻意**不留依赖数组**：处理函数要拿到最新一次渲染里的闭包（附件列表、落点元素），
    // 而几个监听器的重绑在一次渲染里可以忽略不计；写死依赖反而要引入 useCallback
    // 才能避免"闭包过期 → 拖进去的附件是上一轮的"这种更难查的问题。
  })

  const submit = (): void => {
    if (busy || (!value.trim() && attachments.length === 0)) return
    onSubmit(attachments)
    setAttachments([])
  }

  return (
    // 拖拽的三件事（dragover / dragleave / drop）都在上面那段 effect 里挂原生监听，
    // 这里**不再挂 React 的 onDrop** —— 两套处理会让一次拖拽加两遍附件
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

      <textarea
        className="console-input"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />

      {attachError && <div className="console-error">{attachError}</div>}

      <div className="console-toolbar">
        {/* 左右两组各自成簇：换行时整组一起走，避免发送键独自掉到下一行 */}
        <div className="tb-group tb-left">
          <PlusMenu
            picked={pickedSkills ?? []}
            {...(onToggleSkill ? { onToggle: onToggleSkill } : {})}
            onAttach={() => void addAttachment()}
          />
          <BranchChip />
          <PermissionChip />
        </div>

        <div className="tb-group tb-right">
          <ContextRing used={usedTokens} />
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
