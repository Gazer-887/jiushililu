import { useEffect, useState } from 'react'
import { formatSize, imageMimeOf, isTextPreviewable } from '@shared/fs-tree'
import { isHtmlFile, workspaceRelToPreviewUrl } from '@shared/html-preview'
import MessageMarkdown from './MessageMarkdown'
import CodeEditor, { languageOf } from './CodeEditor'

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

  /**
   * HTML 的「渲染 / 源码」开关。
   *
   * 默认**渲染** —— 跟 Markdown 一个道理：打开一个页面文件，想看的是那个页面。
   * 换文件时重置：不能带着上一个文件的选择进下一个。
   *
   * `previewUrl` 为 null（绝对路径 / 越界写法）时**不给**这个开关 ——
   * 给一个注定加载不出来的白框，比没有这个按钮更糟。
   */
  const previewUrl = isHtmlFile(rel) ? workspaceRelToPreviewUrl(rel) : null
  const [htmlRender, setHtmlRender] = useState(true)
  useEffect(() => {
    setHtmlRender(true)
  }, [rel])

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
        {previewUrl && view.kind === 'text' && !editing && (
          <button
            className="fp-html-toggle"
            title={htmlRender ? '看这个文件的原始代码' : '按网页渲染它（沙箱：不执行脚本、不联网）'}
            onClick={() => setHtmlRender((v) => !v)}
          >
            {htmlRender ? '源码' : '渲染'}
          </button>
        )}
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
              {/* 编辑区 —— **Monaco**（plan13 B2）。
                  ⚠️ 三条边界一条都没搬走，它们**从来就不在这个框里**：
                     ① 脏标记：还是 `value={draft}` + `onChange={onEdit}`（回调里跟磁盘内容比）
                     ② 冲突：还是 `save()` 里比 mtime，冲突时把选择权交回用户
                     ③ 截断：`editing` 只在 `canEdit`（= 未截断）时为真，压根到不了这里
                  换内核时最容易死的恰恰是这层**胶水**，不是编辑器本身。
                  ⚠️ 草稿必须留在这个组件里（`draft` state），**不许**搬进 monaco 的 model ——
                     页签一卸载 model 就没了，用户改的字会**静默消失**。 */}
              <CodeEditor
                value={draft}
                language={languageOf(rel)}
                onChange={onEdit}
                onSave={() => void save()}
              />
            </>
          ) : (
            <>
              {previewUrl && htmlRender ? (
                <div className="fp-html-wrap">
                  {/*
                    ⚠️ **别把这段和上面图片那条红线搞混**（那条是 SVG 专属）：

                    SVG 用 `<img>` 就够 —— 只需要"显示"，img 上下文不执行脚本，
                    所以**不需要、也不允许**换成 object/iframe。

                    HTML 不一样："渲染一个页面"本身就得有文档上下文，没有 img 版。
                    既然必须用 frame，就把口子焊死，**两道独立的锁**：
                      ① `sandbox=""`（空值）—— 不执行脚本、不提交表单、不跳转，
                         且是**不透明源**（读不到父页，父页也读不到它）
                      ② 预览响应头里的 CSP —— `script-src 'none'` 断脚本、
                         `default-src 'none'` 断网络（真源见 src/shared/html-preview.ts）
                    响应头那条还顺带兜住"属性被误删"的情况 —— 实测里**不带** sandbox 属性的
                    那一帧同样一行脚本都没跑，就是它挡的。

                    为什么不 `srcdoc`：srcdoc/blob/data 都是本地 scheme，**子文档继承父页策略**，
                    本应用的 `style-src 'self'` 会把预览里的内联样式全砍掉 ——
                    实测三种写法渲染出来都是**白色骨架**。所以走自定义协议（真实 scheme，
                    拿到全新策略容器）。代价在下面那条提示里说清楚，别让人以为坏了。
                  */}
                  <iframe
                    className="fp-html"
                    title={`预览 ${baseName(rel)}`}
                    sandbox=""
                    /* key 跟着 mtime：保存后重新挂载，立刻看到新内容（协议侧也发了 no-store） */
                    key={`${rel}:${view.mtimeMs ?? 0}`}
                    src={previewUrl}
                  />
                  <div className="fp-html-note">
                    沙箱预览：不执行脚本、不联网。外链资源（远程 CSS / JS / 图片）不会加载；
                    同目录的图片与样式能正常显示。要跑脚本看全保真效果，请用系统浏览器打开这个文件。
                  </div>
                </div>
              ) : isMarkdown(rel) ? (
                <div className="fp-md">
                  <MessageMarkdown content={draft || view.content} />
                </div>
              ) : (
                // 非 Markdown 的文本 → **Monaco**（plan13 批 B）：语法高亮 + 行号 + 大文件能翻。
                // ⚠️ 这一版只换"看"这一半（只读）；"改"那一半（下面的 textarea）属 B2。
                //    分开做是有意的：换编辑器内核最容易顺手弄丢的，就是那三条边界。
                <CodeEditor value={draft || view.content} language={languageOf(rel)} readOnly />
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
