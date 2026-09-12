import { useEffect, useState } from 'react'
import { formatSize, imageMimeOf, isTextPreviewable } from '@shared/fs-tree'
import MessageMarkdown from './MessageMarkdown'

// 文件预览（plan9 W3 从 ExplorerPanel 抽出；plan7 批 A3 扩展了**二进制**这条路）。
//
// 改造后文件可以开在**自己的栏**里（右侧独立成栏），所以预览逻辑抽成组件，
// 资源管理器与工作台栏两处共用同一份。
//
// 本批只读：编辑（Markdown 轻编辑）是批 A3 的第二块，`mode` 字段已在模型里预留。

interface Props {
  /** 工作区相对路径 */
  rel: string
  /** 预览 / 编辑 —— 编辑（批 A3 第二块）尚未接入，这里先只做预览 */
  mode?: 'preview' | 'edit'
}

/**
 * 预览的五种状态。
 *
 * 用**判别联合**而不是几个布尔量拼（`isImage` + `isBinary` + `tooLarge` + `error`）——
 * 布尔拼起来会出现"既是图片又是错误"这种非法组合，而联合类型让非法状态**写不出来**。
 */
type View =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; hexHead: string }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string }

const isMarkdown = (name: string): boolean => /\.(md|markdown)$/i.test(name)

const baseName = (rel: string): string => {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : rel
}

export default function FilePreviewPane({ rel, mode = 'preview' }: Props): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setView({ kind: 'loading' })

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
        setView({ kind: 'text', content: res.content, truncated: res.truncated === true })
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
  }, [rel])

  return (
    <div className="fp">
      <div className="fp-head">
        <span className="fp-name" title={rel}>
          {baseName(rel)}
        </span>
        {mode === 'edit' && <span className="fp-badge">编辑（批 A3 接入中）</span>}
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
          {view.truncated && <div className="ex-msg">文件较大，仅显示前 256 KB</div>}
          {isMarkdown(rel) ? (
            <div className="fp-md">
              <MessageMarkdown content={view.content} />
            </div>
          ) : (
            <pre className="fp-pre">{view.content}</pre>
          )}
          <div className="fp-size">{formatSize(view.content.length)}</div>
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
