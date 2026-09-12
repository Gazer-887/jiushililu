import { useEffect, useState } from 'react'
import { isTextPreviewable, formatSize } from '@shared/fs-tree'
import MessageMarkdown from './MessageMarkdown'

// 文件预览（plan9 W3 从 ExplorerPanel 里**抽出来**）。
//
// 为什么现在就抽：改造后文件可以开在**自己的栏**里（右侧独立成栏，W6 接线），
// 预览逻辑要是还埋在资源管理器里，那一栏就没法复用。
// 抽出来之后资源管理器也用同一个组件 —— 一处逻辑，两处挂载。
//
// 本轮只读：编辑（Monaco）属 plan7 批 B，`mode` 字段已在模型里预留。

interface Props {
  /** 工作区相对路径 */
  rel: string
  /** 预览 / 编辑 —— W3 只实现预览，编辑留给批 B */
  mode?: 'preview' | 'edit'
}

const isMarkdown = (name: string): boolean => /\.(md|markdown)$/i.test(name)

const baseName = (rel: string): string => {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : rel
}

export default function FilePreviewPane({ rel, mode = 'preview' }: Props): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setContent(null)
    setErr('')
    setTruncated(false)
    if (!isTextPreviewable(rel)) {
      setErr('这个文件按二进制处理，暂不支持预览')
      return
    }
    void window.api.readWorkspaceFile(rel).then((res) => {
      if (!alive) return
      if (!res.ok) {
        // 失效路径**不为空**：文件被删/换了工作区时，页签仍在、只是显错
        // （plan9 §W2「保留页签并显错」，不是静默丢弃）
        setErr(res.error ?? '读取失败')
        return
      }
      setContent(res.content)
      setTruncated(res.truncated === true)
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
        {mode === 'edit' && <span className="fp-badge">编辑（批 B 接入）</span>}
      </div>
      {err && <div className="ex-msg ex-err">{err}</div>}
      {truncated && <div className="ex-msg">文件较大，仅显示前 256 KB</div>}
      {content !== null &&
        (isMarkdown(rel) ? (
          <div className="fp-md">
            <MessageMarkdown content={content} />
          </div>
        ) : (
          <pre className="fp-pre">{content}</pre>
        ))}
      {content === null && !err && <div className="ex-msg">读取中…</div>}
      {content !== null && <div className="fp-size">{formatSize(content.length)}</div>}
    </div>
  )
}
