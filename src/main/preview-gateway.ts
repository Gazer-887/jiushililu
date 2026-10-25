// 对话内预览的**唯一只读加载缝**（plan74 执行补充 4.3，主进程侧，纯逻辑可单测）。
//
// 这是整个预览功能的「缝」（母本深模块判据）：渲染层、每种格式组件都只认这一个入口，
// 不再各自读路径。Gateway 裁定两件事——**这份引用合法吗**（来源/身份/工作区）、
// **能怎么呈现**（能力位）——然后签发一个**会话绑定的受限句柄**，协议层只按句柄给字节。
//
// 三条铁律：
//  ① 不信渲染层给的任何绝对路径 —— 只信宿主登记的 assetId / 会话记录里的引用 + 原工作区。
//  ② 本地预览与模型出站分离 —— 本缝只服务「本地怎么看」，音频/PDF/Office 在此可看、不出站。
//  ③ 失败拒绝 ≠ 空成功 —— 每个拒绝都有明确原因，渲染层据此给反馈，不静默。
//
// ⚠️ 本文件**不 import electron**：句柄签发与来源裁定是纯逻辑，tests/unit 直接单测；
// 协议挂载（把句柄变成 URL）在装配层 ipc.ts，外设（磁盘/协议）由构造注入。

import { capabilitiesForMime, isSafeAssetId, type PreviewCapabilities, type PreviewSourceKind } from '@shared/conversation-preview'
import { readAsset, assetMetadata } from './preview-assets'
import { statSync, type ReadStream, type Stats } from 'node:fs'
import { resolveInsideWorkspace } from './agent/guard'

// ── 请求 / 响应合同 ───────────────────────────────────────────────────────

export interface PreviewOpenRequest {
  /** 引用来源：history=已发快照 / artifact=Agent 当前产物 / draft=发送前草稿。 */
  source: PreviewSourceKind
  /** 会话身份（history/artifact 必填）。draft 分支可缺省，只查该窗口的宿主草稿登记。 */
  conversationId?: string
  /** 消息身份（history 用）。 */
  messageId?: string
  /** 草稿身份（draft 用）：宿主登记的发送前草稿 id，不是渲染端随口给的。 */
  draftId?: string
  /** 资产身份（history/draft 用）：宿主登记的 attachments/assets 库受限文件名。 */
  assetId?: string
  /** 产物相对路径（artifact 用）：相对所属会话原工作区。 */
  workspaceRel?: string
  /** 展示名。 */
  name: string
  /** MIME（宿主摄取时已探；artifact 由主进程补探）。 */
  mime: string
  /** 原始字节数（呈现用）。 */
  bytes?: number
  /**
   * artifact 专用：**已读好的产物字节**（装配层读盘后传入）。
   * Gateway 只做裁定与签发，不读盘 —— 读盘是 async 的，混进来会逼着整个缝变 async。
   */
  artifactBytes?: Buffer
  /** artifact 内容版本（digest，装配层读盘时算好）。 */
  artifactDigest?: string
  /** 只由宿主文件加载器给出，IPC不接受该字段。 */
  artifactFile?: { root: string; rel: string; bytes: number; stamp: string }
}

export type PreviewErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'too-large'
  | 'unsupported'
  | 'missing-source'

export interface PreviewOpenResult {
  ok: boolean
  /** 失败时的受限错误码（渲染层转人话，不暴露内部细节）。 */
  errorCode?: PreviewErrorCode
  reason?: string
  /** 会话绑定的受限句柄（成功时）：协议层只认它，不认路径。 */
  handleId?: string
  /** 预览能力位。 */
  capabilities?: PreviewCapabilities
  /** 来源标签（history=发送时快照 / current=当前文件 / draft=发送前）。 */
  sourceLabel?: 'history' | 'current' | 'draft'
  /** artifact 的内容版本（digest，用于「已变化/刷新」判定）。 */
  sourceVersion?: string
  /** 文本类预览的有界内容（截断标注由 bytes/boundedText 长度差推）。 */
  boundedText?: string
  /** 是否被截断（文本超限）。 */
  truncated?: boolean
}

export interface PreviewReleaseRequest {
  handleId: string
}

// ── 注入的外设（单测只换这些，不换规则）─────────────────────────────────

export interface PreviewGatewayDeps {
  /** 资产库根目录（userData/assets）：读快照字节用。 */
  assetsRoot: string
  /** 会话是否存在（history/artifact 身份校验）。 */
  conversationExists: (conversationId: string) => boolean
  /** 会话是否绑定了工作区（artifact 身份校验；读盘在装配层做，不经这里）。 */
  conversationHasWorkspace: (conversationId: string) => boolean
  /** history：该 messageId 是否确属该会话（防伪造消息身份读别人的附件）。 */
  messageBelongsToConversation: (conversationId: string, messageId: string) => boolean
  /** 消息存在不等于它拥有任意资产，必须核宿主存档中的引用边。 */
  messageReferencesAsset: (conversationId: string, messageId: string, assetId: string) => boolean
  /** 窗口身份来自IPC sender，草稿id来自宿主签发，不从renderer请求里取owner。 */
  draftAssetOwned: (owner: number | undefined, draftId: string | undefined, assetId: string) => boolean
  /** 注册一个受限句柄 → 字节源。返回不可猜的 handleId。 */
  registerHandle: (handle: PreviewHandle) => string
  /** 撤销句柄（幂等）。 */
  releaseHandle: (handleId: string) => void
}

/** 句柄承载的字节源与生命周期绑定。协议层据此刻画响应。 */
export interface PreviewHandle {
  /** 来自IPC事件的真实窗口身份与短期生命周期，不来自请求字段。 */
  ownerId?: number
  expiresAt?: number
  /** 主进程解析出的只读HTML短期token随句柄一同释放。 */
  memTokens?: string[]
  /** 已发出的文件流随句柄撤销，不能撤销了令牌却仍继续读取。 */
  streams?: Set<ReadStream>
  kind: 'bytes' | 'stream'
  /** bytes 类：整份字节（小文件/图片/文本/Office 解析产物）。 */
  buf?: Buffer
  /** 媒体/PDF：资产根 + assetId，协议层按 Range 供给。 */
  assetsRoot?: string
  assetId?: string
  workspaceRoot?: string
  workspaceRel?: string
  sourceStamp?: string
  mime: string
  bytes: number
  /** 绑定的会话（跨会话读即拒）。 */
  conversationId?: string
}

export function fileSourceStamp(st: Stats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
}

/** 已裁定源的实际读取位置；artifact始终回原会话根，并拒绝签发后变化。 */
export function previewFileSource(handle: PreviewHandle): { path: string; bytes: number } {
  if (handle.assetsRoot && handle.assetId) return assetMetadata(handle.assetsRoot, handle.assetId)
  if (handle.workspaceRoot && handle.workspaceRel) {
    const path = resolveInsideWorkspace(handle.workspaceRoot, handle.workspaceRel)
    if (!path) throw new Error('产物路径已越界')
    const st = statSync(path)
    if (!st.isFile() || fileSourceStamp(st) !== handle.sourceStamp) throw new Error('产物已变化，请刷新预览')
    return { path, bytes: st.size }
  }
  throw new Error('预览文件源缺失')
}

// ── Gateway ───────────────────────────────────────────────────────────────

const TEXT_MIME_MAX = 512 * 1024 // 文本有界预览上限（与工作区预览 256KB 同族，取 512KB 留余地）

export function createPreviewGateway(deps: PreviewGatewayDeps): {
  open: (req: PreviewOpenRequest, owner?: number) => PreviewOpenResult
  release: (req: PreviewReleaseRequest) => void
} {
  function deny(code: PreviewErrorCode, reason: string): PreviewOpenResult {
    return { ok: false, errorCode: code, reason }
  }

  function open(req: PreviewOpenRequest, owner?: number): PreviewOpenResult {
    // ① 形状校验：不信任何未登记字段
    if (!req.name || !req.mime) return deny('bad-request', '引用缺少名称或类型')

    const caps = capabilitiesForMime(req.mime)

    // ② 按来源分流裁定
    if (req.source === 'history' || req.source === 'draft') {
      // 快照 / 草稿：只认宿主登记的 assetId，不接受绝对路径
      if (!req.assetId) return deny('bad-request', '快照引用缺少资产身份')
      if (!isSafeAssetId(req.assetId)) return deny('forbidden', '资产身份形状不合法')
      if (req.source === 'history') {
        // history：会话身份 + 消息归属**都必填且必核** —— 缺一即拒（防伪造身份读别人附件）
        if (!req.conversationId) return deny('bad-request', '快照引用缺少会话身份')
        if (!req.messageId) return deny('bad-request', '快照引用缺少消息身份')
        if (!deps.conversationExists(req.conversationId)) return deny('not-found', '所属会话不存在')
        if (!deps.messageBelongsToConversation(req.conversationId, req.messageId)) {
          return deny('forbidden', '该消息不属于此会话')
        }
        if (!deps.messageReferencesAsset(req.conversationId, req.messageId, req.assetId)) {
          return deny('forbidden', '该消息未引用此附件')
        }
      } else {
        // draft：该 assetId 必须是宿主摄取登记过的（防未登记草稿/渲染层伪造放行）
        if (!deps.draftAssetOwned(owner, req.draftId, req.assetId)) return deny('forbidden', '该草稿未登记或不属于此窗口')
      }
      let buf: Buffer | undefined
      let size: number
      try {
        if (caps.media || caps.pdf) size = assetMetadata(deps.assetsRoot, req.assetId).bytes
        else { buf = readAsset(deps.assetsRoot, req.assetId); size = buf.length }
      } catch {
        return deny('not-found', '附件副本缺失（可能已被清理）')
      }
      // 句柄：图片/文本/Office 走 bytes；媒体/PDF 走 stream（按 Range 供给）
      const handle: PreviewHandle = caps.media || caps.pdf
        ? { kind: 'stream', assetsRoot: deps.assetsRoot, assetId: req.assetId, mime: req.mime, bytes: size, ...(req.conversationId ? { conversationId: req.conversationId } : {}) }
        : { kind: 'bytes', buf, assetsRoot: deps.assetsRoot, assetId: req.assetId, mime: req.mime, bytes: size, ...(req.conversationId ? { conversationId: req.conversationId } : {}) }
      handle.ownerId = owner
      const handleId = deps.registerHandle(handle)
      const res: PreviewOpenResult = {
        ok: true,
        handleId,
        capabilities: caps,
        sourceLabel: req.source === 'history' ? 'history' : 'draft'
      }
      // 文本类：附有界内容（供就地渲染，不落协议）
      if (buf && (caps.text || caps.html)) {
        const truncated = buf.byteLength > TEXT_MIME_MAX
        res.boundedText = buf.subarray(0, TEXT_MIME_MAX).toString('utf8')
        res.truncated = truncated
      }
      return res
    }

    // ③ artifact：Agent 产物，读所属会话原工作区的**当前**文件（字节由装配层读好传入）
    if (req.source === 'artifact') {
      if (!req.conversationId) return deny('bad-request', '产物引用缺少会话身份')
      if (!req.workspaceRel) return deny('bad-request', '产物引用缺少工作区路径')
      if (!deps.conversationExists(req.conversationId)) return deny('not-found', '所属会话不存在')
      if (!deps.conversationHasWorkspace(req.conversationId)) return deny('not-found', '找不到该会话的工作区')
      // 字节由装配层读好（越界/缺失在那里就已拒）；这里只认已读到的字节
      if (!req.artifactBytes && !req.artifactFile) return deny('not-found', '产物文件不存在或已被移动')
      const buf = req.artifactBytes
      const handle: PreviewHandle = {
        kind: req.artifactFile && !buf ? 'stream' : 'bytes',
        ...(buf ? { buf } : {}),
        ...(req.artifactFile ? { workspaceRoot: req.artifactFile.root, workspaceRel: req.artifactFile.rel, sourceStamp: req.artifactFile.stamp } : {}),
        mime: req.mime,
        bytes: req.artifactFile?.bytes ?? buf!.length,
        conversationId: req.conversationId
      }
      handle.ownerId = owner
      const handleId = deps.registerHandle(handle)
      const res: PreviewOpenResult = {
        ok: true,
        handleId,
        capabilities: caps,
        sourceLabel: 'current',
        ...(req.artifactDigest ? { sourceVersion: req.artifactDigest } : {})
      }
      if (buf && (caps.text || caps.html)) {
        const truncated = buf.byteLength > TEXT_MIME_MAX
        res.boundedText = buf.subarray(0, TEXT_MIME_MAX).toString('utf8')
        res.truncated = truncated
      }
      return res
    }

    return deny('bad-request', '未知的引用来源')
  }

  function release(req: PreviewReleaseRequest): void {
    if (!req.handleId) return
    deps.releaseHandle(req.handleId)
  }

  return { open, release }
}
