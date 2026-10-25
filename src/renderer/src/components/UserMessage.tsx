import { useState } from 'react'
import { splitAttachmentBlocks } from '@shared/attachment-block'
import { estimateImageTokens } from '@shared/tokens'
import type { ContentPart } from '@shared/content-parts'
import type { LocalFileRef } from '@shared/conversation-preview'
import FilePreviewCard from './FilePreviewCard'

/**
 * 用户气泡（plan57 片① + plan74）：附件折成 chip，正文照常显示。
 * ⚠️ 只改呈现 —— 发出去的正文永远是含完整块文本的那一条，折叠不许改变出境内容（判据在 attachment-block.test）。
 * 顺序与出境相反：用户自己的话是主角，放最前；附件收成一行，点开才看内容。
 *
 * 图片 chip 的 MIME 只从 `parts`（引用制的那份真相）取，marker 文本里没有这个字段 ——
 * 两处都能提供时以 parts 为准，缺了对应项就按"图，类型未知"呈现，不猜。
 *
 * plan74：`localFiles`（本地预览引用）在此渲染成就地预览卡 —— 非媒体文件（PDF/音频/Office/文本）
 * 也能就地看，不必去资源管理器。卡片只读、按需加载、展开/卸载释放句柄。
 */
export default function UserMessage({
  text,
  parts,
  localFiles,
  conversationId,
  messageId
}: {
  text: string
  parts?: ContentPart[]
  localFiles?: LocalFileRef[]
  conversationId?: string
  messageId?: string
}): JSX.Element {
  const { files, body } = splitAttachmentBlocks(text)
  const [open, setOpen] = useState<boolean[]>([])
  // 引用制下 marker 里没有 MIME：类型角标只从 parts（那份真相）取，取不到就写"图片/视频"不猜
  const mimeByRef = new Map(
    (parts ?? []).flatMap((p) => (p.type === 'text' ? [] : [[p.ref, p.mime] as const]))
  )

  if (files.length === 0 && (localFiles?.length ?? 0) === 0) return <>{text}</>

  const toggle = (n: number): void =>
    setOpen((s) => {
      const next = [...s]
      next[n] = !next[n]
      return next
    })

  return (
    <>
      {body && <div className="msg-attach-question">{body}</div>}
      <div className="msg-attach-list" role="group" aria-label="本条消息附带的文件">
        {files.map((f, n) => {
          const media = f.image ?? f.video
          if (media) {
            if (localFiles?.some(file => file.assetId === media.ref)) return null
            const mime = mimeByRef.get(media.ref)
            if (mime && conversationId && messageId) return (
              <FilePreviewCard key={`${media.ref}-${n}`} conversationId={conversationId} messageId={messageId}
                file={{ assetId: media.ref, name: f.name, mime, bytes: media.bytes, source: 'history' }} />
            )
            const isVideo = media.type === 'video'
            return (
              <span
                key={`${f.name}-${n}`}
                className={`msg-attach-chip msg-attach-media ${isVideo ? 'msg-attach-video' : 'msg-attach-image'}`}
                title={
                  isVideo
                    ? '视频按引用发送 · 仅 OpenAI 兼容端点支持'
                    : `图片按引用发送 · 估算约 ${estimateImageTokens()} token`
                }
              >
                <span className="msg-attach-name">{f.name}</span>
                <span className="msg-attach-kind">
                  {mimeByRef.get(media.ref)?.replace(`${media.type}/`, '') ?? (isVideo ? '视频' : '图片')}
                </span>
              </span>
            )
          }
          return (
            <button
              key={`${f.name}-${n}`}
              className="msg-attach-chip"
              aria-expanded={open[n] === true}
              title={open[n] ? '收起文件内容' : '展开查看文件内容'}
              onClick={() => toggle(n)}
            >
              <span className="msg-attach-name">{f.name}</span>
              {f.truncated && <span className="attach-trunc">截断</span>}
              <span className="msg-attach-caret">{open[n] ? '▴' : '▾'}</span>
            </button>
          )
        })}
      </div>
      {files.map((f, n) =>
        !f.image && !f.video && open[n] === true ? (
          <pre key={`body-${f.name}-${n}`} className="msg-attach-body">
            {f.content}
          </pre>
        ) : null
      )}
      {localFiles && localFiles.length > 0 && (
        <div className="msg-local-files" role="group" aria-label="本条消息的本地文件预览">
          {localFiles.map((f) => (
            <FilePreviewCard
              key={`${f.assetId}-${f.name}`}
              file={f}
              {...(conversationId ? { conversationId } : {})}
              {...(messageId ? { messageId } : {})}
            />
          ))}
        </div>
      )}
    </>
  )
}
