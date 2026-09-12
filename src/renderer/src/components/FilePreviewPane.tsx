import { useEffect, useState } from 'react'
import { formatSize, imageMimeOf, isTextPreviewable } from '@shared/fs-tree'
import MessageMarkdown from './MessageMarkdown'

// 文件预览 + **Markdown 轻编辑**（plan9 W3 抽出；plan7 批 A3 范围②）
//
// 编辑器故意**不是 Monaco**：这一批要的是"够改就行"，通用代码编辑器是批 B 的事
//（语法高亮 / 多光标 / 大文件 / Diff 都在那边）。这里就是一个 textarea + 保存。
//
// ## 三条边界（计划里写死的，不写清就会出"丢数据"这类事）
//
//   ① **脏标记**：改了没存 → 页签上打点、关页签时**拦住问一句**（不静默丢）。
//      草稿住在布局的 `tab.content.dirty` 里（不是组件 state）——
//      切换页签会让本组件**卸载**，存组件里当场就没；存布局里则连**重启都还在**。
//   ② **外部冲突**：文件可能被 Agent 或别的程序改过 → 保存前比对 mtime，
//      不一致**不写盘**，给"覆盖 / 重新载入"两个选择，**不做静默覆盖**。
//   ③ **大文件**：超过预览上限（256KB）的文件**不给编辑** ——
//      因为读都只读了前一段，保存回去会把没读到的部分**整个冲掉**。
//
// ## 保存为什么走 `writeWorkspaceFile`
//
// 那是**统一写入服务**：界面与 Agent 走同一条路 → 自动进检查点 →
// 「文件变更记录」里看得见、退得回（plan7 批 A2 立的地基，这里只是它的消费者）。

interface Props {
  /** 工作区相对路径 */
  rel: string
  /** 预览 / 编辑 */
  mode?: 'preview' | 'edit'
  /** 未保存的草稿（来自布局；有它才算"脏"） */
  dirty?: string
  onModeChange?: (mode: 'preview' | 'edit') => void
  onDirtyChange?: (dirty: string | undefined) => void
}

/**
 * 预览的五种状态。
 *
 * 用**判别联合**而不是几个布尔量拼（`isImage` + `isBinary` + `tooLarge` + `error`）——
 * 布尔拼起来会出现"既是图片又是错误"这种非法组合，而联合类型让非法状态**写不出来**。
 */
type View =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean; mtimeMs?: number }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; hexHead: string }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string }

const isMarkdown = (name: string): boolean => /\.(md|markdown)$/i.test(name)

const baseName = (rel: string): string => {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : rel
}

export default function FilePreviewPane({
  rel,
  mode = 'preview',
  dirty,
  onModeChange,
  onDirtyChange
}: Props): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'loading' })
  /** 编辑器里的文本（进入编辑 / 载入文件时用 `dirty ?? 磁盘内容` 初始化） */
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    let alive = true
    setView({ kind: 'loading' })
    setSaveMsg(null)
    setConflict(false)

    const name = baseName(rel)

    // ① 图片：走**二进制**通道拿 data URL
    if (imageMimeOf(name)) {
      void window.api.readWorkspaceBinary(rel).then((res) => {
        if (!alive) return
        if (!res.ok) return setView({ kind: 'error', message: res.error ?? '读取失败' })
        if (res.tooLarge) return setView({ kind: 'tooLarge', size: res.size })
        if (!res.dataUrl) return setView({ kind: 'error', message: '图片数据为空' })
        setView({ kind: 'image', dataUrl: res.dataUrl })
      })
      return () => {
        alive = false
      }
    }

    // ② 文本（含 Markdown）：走文本通道
    if (isTextPreviewable(name)) {
      void window.api.readWorkspaceFile(rel).then((res) => {
        if (!alive) return
        if (!res.ok) {
          // 失效路径**不为空**：文件被删/换了工作区时，页签仍在、只是显错
          return setView({ kind: 'error', message: res.error ?? '读取失败' })
        }
        setView({
          kind: 'text',
          content: res.content,
          truncated: res.truncated === true,
          ...(res.mtimeMs !== undefined ? { mtimeMs: res.mtimeMs } : {})
        })
        // 草稿优先：切回这个页签时，没保存的内容要还在
        setDraft(dirty ?? res.content)
      })
      return () => {
        alive = false
      }
    }

    // ③ 其余二进制：**降级而不是放弃** —— 给十六进制转储，看文件头就能认出它是什么
    void window.api.readWorkspaceBinary(rel).then((res) => {
      if (!alive) return
      if (!res.ok) return setView({ kind: 'error', message: res.error ?? '读取失败' })
      if (res.hexHead) return setView({ kind: 'binary', hexHead: res.hexHead })
      setView({ kind: 'error', message: '读不出内容' })
    })
    return () => {
      alive = false
    }
    // `dirty` 刻意**不进依赖**：它每次按键都变，进依赖会把文件重读一遍、
    // 顺带把刚打的字冲掉。切回页签时草稿由组件重新挂载时读取，够用。
  }, [rel])

  /** 能编辑的前提：是文本，**且没被截断**（边界③ —— 截断的文件保存回去会冲掉后半段） */
  const canEdit = view.kind === 'text' && !view.truncated
  const editing = mode === 'edit' && canEdit

  const reload = async (): Promise<void> => {
    const res = await window.api.readWorkspaceFile(rel)
    if (!res.ok) return setView({ kind: 'error', message: res.error ?? '读取失败' })
    setView({
      kind: 'text',
      content: res.content,
      truncated: res.truncated === true,
      ...(res.mtimeMs !== undefined ? { mtimeMs: res.mtimeMs } : {})
    })
    setDraft(res.content)
    setConflict(false)
    setSaveMsg('已按磁盘上的内容重新载入')
    onDirtyChange?.(undefined)
  }

  /**
   * 保存。
   * `force = true` 走"覆盖"：**不带** mtime 基线，主进程就不做冲突检查（用户明确选了覆盖）。
   */
  const save = async (force = false): Promise<void> => {
    if (view.kind !== 'text' || saving) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await window.api.writeWorkspaceFile(
        rel,
        draft,
        force ? undefined : view.mtimeMs
      )
      if (!res.ok) {
        if (res.conflict) {
          // **不静默覆盖**：把选择权交回用户（边界②）
          setConflict(true)
          return
        }
        setSaveMsg(res.message)
        return
      }
      setConflict(false)
      setSaveMsg('已保存')
      // 基线跟着更新，否则下一次保存会自己撞上"文件被改过"（就是自己刚写的）
      setView((v) => (v.kind === 'text' ? { ...v, content: draft, mtimeMs: res.mtimeMs } : v))
      onDirtyChange?.(undefined)
    } finally {
      setSaving(false)
    }
  }

  const onEdit = (next: string): void => {
    setDraft(next)
    // 草稿写回布局（父组件防抖落盘）；与磁盘一致时算"不脏"
    const disk = view.kind === 'text' ? view.content : ''
    onDirtyChange?.(next === disk ? undefined : next)
  }

  return (
    <div className="fp">
      <div className="fp-head">
        <span className="fp-name" title={rel}>
          {baseName(rel)}
        </span>
        {dirty !== undefined && <span className="fp-dirty">未保存</span>}
        {canEdit && (
          <button
            className="fp-mode"
            title={editing ? '切回预览（草稿会留着）' : '编辑这个文件'}
            onClick={() => onModeChange?.(editing ? 'preview' : 'edit')}
          >
            {editing ? '预览' : '编辑'}
          </button>
        )}
      </div>

      {view.kind === 'error' && <div className="ex-msg ex-err">{view.message}</div>}

      {view.kind === 'tooLarge' && (
        <div className="ex-msg">
          这张图 {formatSize(view.size)}，超过 {formatSize(8 * 1024 * 1024)} 的预览上限，
          为免界面卡住不加载。用「在系统文件管理器中显示」打开它。
        </div>
      )}

      {view.kind === 'text' && (
        <>
          {view.truncated && (
            <div className="ex-msg">
              文件较大，仅显示前 256 KB —— 因此这个文件不提供编辑：
              保存回去会把没读到的部分冲掉。
            </div>
          )}
          {editing ? (
            <>
              <div className="fp-edit-bar">
                <button className="fp-btn" disabled={saving} onClick={() => void save()}>
                  保存
                </button>
                <span className="fp-hint">Ctrl+S</span>
                {conflict ? (
                  <>
                    <span className="fp-warn">文件在打开之后被改过</span>
                    <button className="fp-btn" onClick={() => void save(true)}>
                      覆盖
                    </button>
                    <button className="fp-btn" onClick={() => void reload()}>
                      重新载入
                    </button>
                  </>
                ) : (
                  saveMsg && <span className="fp-msg">{saveMsg}</span>
                )}
              </div>
              <textarea
                className="fp-textarea"
                spellCheck={false}
                value={draft}
                onChange={(e) => onEdit(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void save()
                  }
                }}
              />
            </>
          ) : (
            <>
              {isMarkdown(rel) ? (
                <div className="fp-md">
                  <MessageMarkdown content={draft || view.content} />
                </div>
              ) : (
                <pre className="fp-pre">{draft || view.content}</pre>
              )}
              <div className="fp-size">{formatSize((draft || view.content).length)}</div>
            </>
          )}
        </>
      )}

      {view.kind === 'image' && (
        <div className="fp-image">
          {/*
            ⚠️ **安全红线**：只能这样用 `<img src>` 渲染用户文件。
            SVG 是可执行内容（能带 <script>），而 img 上下文**不执行脚本**。
            换成 <object> / <iframe> / 内联 SVG 就等于执行工作区里的代码 —— 不许换。
          */}
          <img className="fp-img" src={view.dataUrl} alt={baseName(rel)} />
        </div>
      )}

      {view.kind === 'binary' && (
        <>
          <div className="ex-msg">二进制文件 —— 下面是文件头（帮助辨认这是什么格式）</div>
          <pre className="fp-hex">{view.hexHead}</pre>
        </>
      )}

      {view.kind === 'loading' && <div className="ex-msg">读取中…</div>}
    </div>
  )
}
