// 对话内文件预览卡（plan74）：三入口共用的就地预览组件。
//
// 一个文件 = 一张卡。卡默认紧凑（文件名 + 类型 + 大小），点展开才就地呈现内容：
//  · 图片 → <img>（缩略图/放大，点击进同窗浮层）
//  · 文本/代码/MD → 有界内容（截断标注，内部滚动）
//  · 静态 HTML → 沙箱 iframe（断脚本断网，复用 jsl-preview 既有策略）
//  · PDF → 可信React＋本地pdfjs worker画布（真实页面、翻页/缩放）
//  · MP4/音频 → <video>/<audio>（Range 供给，单播放协调）
//  · docx/xlsx → 沙箱 iframe（主进程解析产物）
//  · 未知/PPTX → 明确降级 + 系统打开出口（用户主动）
//
// ⚠️ 只读呈现：查看不写盘、不执行、不自动联网。所有字节经 Gateway 签发句柄 → jsl-preview://asset/。
// 复用 ToolShot 的按需加载模式（useEffect + IPC + 加载/失败态），不把字节塞进消息。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LocalFileRef, PreviewSourceKind } from '@shared/conversation-preview'
import type { PreviewOpenOutput } from '@shared/preview-ipc-types'
import { MediaCoordinator, type MediaElement, type MediaPositionKey } from '../media-coordinator'
import PdfPreview from './PdfPreview'
import ImagePreview from './ImagePreview'
import MessageMarkdown from './MessageMarkdown'
import './file-preview.css'

/** 进程级单协调器（一个主窗口一个会话视图，够用；多窗口各自渲染进程独立）。 */
const mediaCoordinator = new MediaCoordinator()

/** 人类可读的大小（二进制单位，与预算口径一致）。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 来源标签（发送时快照 / 当前文件 / 发送前）。 */
function sourceLabelText(label: PreviewOpenOutput['sourceLabel']): string {
  if (label === 'history') return '发送时快照'
  if (label === 'current') return '当前文件'
  return '待发送'
}

export interface FilePreviewCardProps {
  /** 本地文件引用（来自消息的 localFiles，或产物引用）。 */
  file: LocalFileRef
  /** 所属会话（Gateway 需要；草稿态可空）。 */
  conversationId?: string
  /** 消息身份（history 用）。 */
  messageId?: string
  /** 移除回调（仅草稿态用：发送前从输入区删掉这个附件）。传了才显示移除按钮。 */
  onRemove?: () => void
  /** 发送前说明模型可见范围；本地可看不等于已发给模型。 */
  deliveryNote?: string
}

/**
 * 单文件预览卡。展开时经 Gateway 打开（签发句柄 → URL），按能力呈现。
 * 收起/卸载时释放句柄（不误删持久资产）。
 */
export default function FilePreviewCard({ file, conversationId, messageId, onRemove, deliveryNote }: FilePreviewCardProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewOpenOutput | null>(null)
  const [sheet, setSheet] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [changed, setChanged] = useState(false)
  const lastVersion = useRef<{ identity: string; version: string } | null>(null)

  // 媒体进度键：稳定（useMemo），否则每次渲染都是新对象 → MediaPlayer 的 effect 反复重注册。
  // 键用 assetId（history/draft）；artifact 无 assetId 时退到 workspaceRel，够区分不同文件。
  const mediaKey = useMemo<MediaPositionKey>(
    () => ({
      conversationId: conversationId ?? 'draft',
      assetId: file.assetId || file.workspaceRel || file.name,
      sourceVersion: preview?.sourceVersion ?? file.digest
    }),
    [conversationId, file.assetId, file.workspaceRel, file.name, preview?.sourceVersion, file.digest]
  )

  // 展开时才打开预览（按需，不预加载所有文件）
  useEffect(() => {
    setPreview(null)
    setSheet(0)
    if (!open && !file.mime.startsWith('image/')) {
      setLoading(false)
      return
    }
    let alive = true
    // 资源属于本次effect，不属于组件的最后一个全局槽。换源、收起和卸载均释放这一笔。
    let ownedHandle: string | undefined
    setLoading(true)
    setError(null)
    void window.api
      .previewOpen({
        source: file.source as PreviewSourceKind,
        ...(conversationId ? { conversationId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(file.draftId ? { draftId: file.draftId } : {}),
        ...(file.assetId ? { assetId: file.assetId } : {}),
        ...(file.workspaceRel ? { workspaceRel: file.workspaceRel } : {}),
        name: file.name,
        mime: file.mime,
        bytes: file.bytes
      })
      .then((res) => {
        if (!alive) {
          // 组件已卸载：释放刚拿到的句柄，不泄漏
          if (res.ok && res.handleId) void window.api.previewRelease(res.handleId)
          return
        }
        if (res.ok) {
          ownedHandle = res.handleId
          if (res.sourceVersion) {
            const identity = `${conversationId ?? ''}\u0000${file.workspaceRel ?? file.assetId}`
            setChanged(lastVersion.current?.identity === identity && lastVersion.current.version !== res.sourceVersion)
            lastVersion.current = { identity, version: res.sourceVersion }
          }
          setPreview(res)
        } else {
          setError(res.reason ?? '无法预览该文件')
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      if (ownedHandle) void window.api.previewRelease(ownedHandle)
    }
  }, [open, refresh, file.assetId, file.workspaceRel, file.source, file.draftId, file.name, file.mime, file.bytes, conversationId, messageId])

  const caps = preview?.capabilities
  const kb = humanSize(preview?.bytes ?? file.bytes)
  const mime = preview?.mime ?? file.mime

  return (
    <div className="fp-card" data-source={file.source} data-expanded={open} data-preview-mime={preview?.mime ?? file.mime}>
      <button
        className="fp-card-head"
        aria-expanded={open}
        title={open ? '收起' : '展开预览'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fp-card-name">{file.name}</span>
        <span className="fp-card-meta">
          {preview?.sourceLabel ? sourceLabelText(preview.sourceLabel) : file.source === 'artifact' ? '当前文件' : file.source === 'history' ? '发送时快照' : '待发送'}
          {file.outside ? ' · 工作区外' : ''} · {kb}
        </span>
        <span className="fp-card-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {deliveryNote && <div className="fp-delivery-note">{deliveryNote}</div>}
      {open && file.source === 'artifact' && <div className="fp-current-toolbar">
        <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新当前文件</button>
        {changed && <span className="fp-version-note">内容已更新</span>}
      </div>}
      {onRemove && (
        <button
          className="fp-card-remove"
          title="移除"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      )}

      {(open || file.mime.startsWith('image/')) && (
        <div className="fp-card-body">
          {loading && <div className="fp-card-loading">加载中…</div>}
          {error && <div className="fp-card-error">{error}</div>}
          {/* R5：明确降级（如 PDF 解析失败）—— 显示原因 + 系统打开出口，不假装成功 */}
          {preview?.degraded && (
            <div className="fp-card-degraded">
              预览降级：{preview.degraded}
              <SystemOpenButton handleId={preview.handleId} />
            </div>
          )}
          {!loading && !error && preview && (
            <>
              {caps?.image && preview.url && (
                <ImagePreview url={preview.url} name={file.name} />
              )}
              {caps?.media && preview.url && (
                <MediaPlayer
                  url={preview.url}
                  mime={mime}
                  name={file.name}
                  positionKey={mediaKey}
                />
              )}
              {caps?.text && mime === 'text/markdown' && preview.boundedText !== undefined && <div className="fp-card-text fp-card-markdown">
                <MessageMarkdown content={preview.boundedText} readonlyPreview />
                {preview.truncated && <div className="fp-card-trunc">（内容过长，已截断显示）</div>}
              </div>}
              {(caps?.text || caps?.html) && mime !== 'text/markdown' && preview.boundedText !== undefined && (
                <pre className="fp-card-text">
                  {preview.boundedText}
                  {preview.truncated && <div className="fp-card-trunc">（内容过长，已截断显示）</div>}
                </pre>
              )}
              {caps?.html && preview.url && (
                <iframe className="fp-card-html" src={preview.url} sandbox="" title={file.name} />
              )}
              {caps?.pdf && preview.handleId && (
                <PdfPreview handleId={preview.handleId} name={file.name} />
              )}
              {caps?.office && !preview.degraded && preview.url && (
                <>
                  {preview.officeSheets && (
                    <label className="fp-sheet-picker">工作表
                      <select aria-label="工作表" value={sheet} onChange={event => setSheet(Number(event.target.value))}>
                        {preview.officeSheets.map((entry, index) => <option key={index} value={index}>{entry.name}</option>)}
                      </select>
                    </label>
                  )}
                  {preview.officeClipped && <div className="fp-card-trunc">（工作表内容或数量超过预览上限，已截断）</div>}
                  <iframe className="fp-card-office" src={preview.officeSheets?.[sheet]?.url ?? preview.url} sandbox="" title={file.name} />
                </>
              )}
              {!caps?.image && !caps?.media && !caps?.text && !caps?.html && !caps?.pdf && !caps?.office && (
                <div className="fp-card-unsupported">
                  该格式暂不支持内嵌预览
                  <SystemOpenButton handleId={preview.handleId} />
                </div>
              )}
              {(caps?.image || caps?.media || caps?.pdf || caps?.office || caps?.text || caps?.html) && !preview.degraded && <SystemOpenButton handleId={preview.handleId} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 媒体播放器：注册进协调器，单播放互斥 + 折叠/卸载即停 + 重开续进度（plan74 故事3）。 */
function MediaPlayer({
  url,
  mime,
  name,
  positionKey
}: {
  url: string
  mime: string
  name: string
  positionKey: MediaPositionKey
}): JSX.Element {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [error, setError] = useState(false)
  const isAudio = mime.startsWith('audio/')

  // 注册到协调器 + 桥接原生播放事件。卸载时注销（= 停 + 存进度）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let pendingSeek: number | undefined
    const restore = (): void => {
      if (pendingSeek === undefined || el.readyState === 0) return
      const at = pendingSeek
      pendingSeek = undefined
      try { el.currentTime = Number.isFinite(el.duration) ? Math.min(at, el.duration) : at } catch { pendingSeek = at }
    }
    const bridge: MediaElement = {
      pause: () => el.pause(),
      currentTime: () => el.currentTime,
      seek: (sec) => {
        pendingSeek = sec
        restore()
      }
    }
    mediaCoordinator.register(positionKey, bridge)
    const onPlay = (): void => mediaCoordinator.onPlay(positionKey, bridge)
    const onPause = (): void => mediaCoordinator.onPause(positionKey, bridge)
    const onTime = (): void => mediaCoordinator.onTimeUpdate(positionKey, bridge)
    el.addEventListener('loadedmetadata', restore)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTime)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', restore)
      mediaCoordinator.unregister(positionKey, bridge)
      // 真实停止下载与解码，而不只从协调表摘掉名字。
      el.removeAttribute('src')
      el.load()
    }
  }, [positionKey, url])

  const commonProps = {
    src: url,
    controls: true,
    preload: 'metadata' as const,
    onError: () => setError(true),
    'data-player-name': name
  }
  return <>{error && <div className="fp-card-error">媒体无法解码或源已失效，请重新打开或使用系统播放器</div>}{isAudio ? (
    <audio ref={ref as React.RefObject<HTMLAudioElement>} className="fp-card-audio" {...commonProps} />
  ) : (
    <video ref={ref as React.RefObject<HTMLVideoElement>} className="fp-card-video" {...commonProps} />
  )}</>
}

/** 系统打开出口（用户主动；未知/PPTX 格式的降级路径）。 */
function SystemOpenButton({ handleId }: { handleId?: string }): JSX.Element | null {
  const [error, setError] = useState<string | null>(null)
  if (!handleId) return null
  return (
    <><button
      className="fp-card-sysopen"
      title="主动交给系统程序打开；文档活动内容由系统程序处理"
      onClick={() => {
        void window.api.openWorkspacePathInSystem('', handleId).then(result => setError(result.ok ? null : result.error ?? '系统打开失败')).catch(() => setError('系统打开失败'))
      }}
    >
      用系统程序打开
    </button>{error && <span className="fp-card-error">{error}</span>}</>
  )
}
