import { useEffect, useState } from 'react'
import type { Attachment } from '@shared/ipc'
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
  showWorkspace = false
}: InputConsoleProps): JSX.Element {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)

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
      setAttachError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((p) => p.path !== path))
  }

  const submit = (): void => {
    if (busy || (!value.trim() && attachments.length === 0)) return
    onSubmit(attachments)
    setAttachments([])
  }

  return (
    <div className="console">
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
        <PlusMenu
          picked={pickedSkills ?? []}
          {...(onToggleSkill ? { onToggle: onToggleSkill } : {})}
          onAttach={() => void addAttachment()}
        />
        <BranchChip />
        <PermissionChip />

        <span className="tb-spacer" />

        <ContextRing used={usedTokens} />
        <PolishButton
          text={value}
          onPolished={(next) => onChange(next)}
        />
        <ModelSwitcher />
        <SendButton
          disabled={busy || (!value.trim() && attachments.length === 0)}
          busy={busy}
          onSend={submit}
          onStop={() => onStop?.()}
        />
      </div>
    </div>
  )
}
