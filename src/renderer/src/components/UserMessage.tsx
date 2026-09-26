import { useState } from 'react'
import { splitAttachmentBlocks } from '@shared/attachment-block'

/**
 * 用户气泡（plan57 片①）：附件折成 chip，正文照常显示。
 * ⚠️ 只改呈现 —— 发出去的正文永远是含完整块文本的那一条，折叠不许改变出境内容（判据在 attachment-block.test）。
 * 顺序与出境相反：用户自己的话是主角，放最前；附件收成一行，点开才看内容。
 */
export default function UserMessage({ text }: { text: string }): JSX.Element {
  const { files, body } = splitAttachmentBlocks(text)
  const [open, setOpen] = useState<boolean[]>([])

  if (files.length === 0) return <>{text}</>

  return (
    <>
      {body && <div className="msg-attach-question">{body}</div>}
      <div className="msg-attach-list" role="group" aria-label="本条消息附带的文件">
        {files.map((f, n) => (
          <button
            key={`${f.name}-${n}`}
            className="msg-attach-chip"
            aria-expanded={open[n] === true}
            title={open[n] ? '收起文件内容' : '展开查看文件内容'}
            onClick={() =>
              setOpen((s) => {
                const next = [...s]
                next[n] = !next[n]
                return next
              })
            }
          >
            <span className="msg-attach-name">{f.name}</span>
            {f.truncated && <span className="attach-trunc">截断</span>}
            <span className="msg-attach-caret">{open[n] ? '▴' : '▾'}</span>
          </button>
        ))}
      </div>
      {files.map((f, n) =>
        open[n] === true ? (
          <pre key={`body-${f.name}-${n}`} className="msg-attach-body">
            {f.content}
          </pre>
        ) : null,
      )}
    </>
  )
}
