// 对话内预览的组合根（plan74，主进程侧）：把 Gateway / 协议 / 资产预算 / 会话查询装配成一个单元。
//
// 这里是**唯一**注入真实外设的地方（electron app、会话存储、工作区解析、协议表）。
// Gateway 本体（preview-gateway.ts）保持纯逻辑可单测；这里只做接线。
//
// 暴露给 ipc.ts 的三个动作：open（打开预览）/ release（释放句柄）/ ingestDraft（发送前摄取外部文件）。

import { randomBytes, createHash } from 'node:crypto'
import { app, shell, nativeImage } from 'electron'
import { createPreviewGateway, fileSourceStamp, previewFileSource, type PreviewGatewayDeps, type PreviewHandle } from './preview-gateway'
import { assetsDir, ingestAsset, storeAssetBuffer, readAsset, assetBudgetForRoot, type AssetBudget, type AssetPublisher } from './preview-assets'
import { assetPreviewUrl, capabilitiesForMime, type PreviewCapabilities, type PreviewSourceKind } from '@shared/conversation-preview'
import { getConversation } from './store/conversations'
import { resolveInsideWorkspace } from './agent/guard'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type {
  PreviewOpenInput,
  PreviewOpenOutput,
  PreviewIngestInput,
  PreviewIngestOutput
} from '@shared/preview-ipc-types'
import { createLogger } from './log'
import { memPreviews, parseDocxBuffer, parseSheetBuffer } from './office-preview'
import { memPreviewUrl } from '@shared/office-preview'
import { MAX_ASSET_BYTES } from '@shared/conversation-preview'
import { PreviewIdentities } from './preview-identities'
import type { Attachment, ChatMessage } from '@shared/ipc'
import { previewMimeOf } from '@shared/conversation-preview'
import { basename } from 'node:path'
import type { WebContents } from 'electron'
import { saveAttachmentImage } from './attachments-store'
import { MAX_OUTBOUND_IMAGE_BYTES } from '@shared/content-parts'
import type { AttachmentPublisher } from './workspace-fs'

const log = createLogger('preview')

/** 进程级预算账本（单例）。附件摄取与草稿摄取共用这一份。 */
export function getAssetBudget(): AssetBudget { return assetBudgetForRoot(app.getPath('userData')) }

/** 无磁盘路径的粘贴图片也走同一预算、排他落盘和可撤销宿主登记事务。 */
export function ingestClipboardImage(bytes: Uint8Array, sender: WebContents): Attachment {
  if (!bytes.byteLength || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('粘贴图片为空或超过50MiB')
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  const size = image.getSize()
  if (image.isEmpty() || !size.width || size.width * size.height > 16 * 1024 * 1024) throw new Error('粘贴图片无法解码或尺寸超出安全上限')
  const buf = image.toPNG()
  if (buf.length > MAX_ASSET_BYTES) throw new Error('粘贴图片转换后超过50MiB')
  const publish = attachmentPreviewPublisher(sender)
  let attachment: Attachment | undefined
  const publication: AssetPublisher = id => {
      const draft: Attachment = { name: '粘贴图片.png', path: id.assetId, content: '', truncated: false, bytes: id.bytes,
        preview: { assetId: id.assetId, digest: id.digest, mime: 'image/png' },
        ...(id.bytes <= MAX_OUTBOUND_IMAGE_BYTES ? { image: { type: 'image' as const, ref: id.assetId, mime: 'image/png' as const, bytes: id.bytes } } : {}) }
      const result = publish(draft); attachment = result.attachment; return result.rollback
  }
  const root = app.getPath('userData')
  const saved = buf.length <= MAX_OUTBOUND_IMAGE_BYTES
    ? saveAttachmentImage(root, { mime: 'image/png', buf, now: () => new Date(), budget: getAssetBudget(), publish: publication })
    : storeAssetBuffer(buf, '粘贴图片.png', assetsDir(root), getAssetBudget(), undefined, publication).ok
  if (!saved || !attachment) throw new Error('粘贴图片未能落盘，附件未添加')
  return attachment
}
const identities = new PreviewIdentities()
const observedOwners = new Set<number>()

/** 窗口身份只由IPC事件提供。销毁时撤销其草稿能力，不删除持久资产。 */
export function observePreviewOwner(sender: WebContents): number {
  if (sender.isDestroyed()) throw new Error('预览窗口已关闭')
  const owner = sender.id
  if (!observedOwners.has(owner)) {
    observedOwners.add(owner)
    sender.once('destroyed', () => {
      identities.revokeOwner(owner)
      observedOwners.delete(owner)
      for (const [id, handle] of handles) if (handle.ownerId === owner) disposeHandle(id)
    })
  }
  return owner
}

/** 真正发布附件身份之前重核窗口仍存活，结算失败撤回这一笔draft。 */
export function attachmentPreviewPublisher(sender: WebContents): AttachmentPublisher {
  const owner = observePreviewOwner(sender)
  return attachment => {
    if (sender.isDestroyed()) throw new Error('附件摄取完成前窗口已关闭')
    const registered = registerAttachmentPreview(attachment, owner)
    return { attachment: registered, rollback: () => {
      if (registered.preview?.draftId) identities.revokeDraft(registered.preview.draftId)
    } }
  }
}

/** 附件热路径和显式摄取共用同一草稿身份登记，不能只把assetId放进进程级Set。 */
export function registerAttachmentPreview(attachment: Attachment, owner: number): Attachment {
  const media = attachment.image ?? attachment.video
  const preview = attachment.preview ?? (media ? {
    assetId: media.ref, mime: media.mime,
    digest: createHash('sha256').update(readAsset(assetsDir(app.getPath('userData')), media.ref)).digest('hex').slice(0, 16)
  } : undefined)
  if (!preview) return attachment
  const file = identities.register(owner, {
    assetId: preview.assetId, name: attachment.name,
    mime: media?.mime ?? preview.mime,
    bytes: attachment.bytes, digest: preview.digest,
    ...(attachment.outside !== undefined ? { outside: attachment.outside } : {})
  })
  return { ...attachment, preview: { ...preview, draftId: file.draftId } }
}

export function preparePreviewMessages(messages: ChatMessage[], existing: ChatMessage[], owner: number): ChatMessage[] {
  return identities.prepare(messages, existing, owner)
}

export function commitPreviewMessages(messages: ChatMessage[], owner: number): void {
  identities.committed(messages, owner)
}

/** history：该 messageId 是否确属该会话（Gateway 防伪造消息身份）。 */
function messageBelongsToConversation(conversationId: string, messageId: string): boolean {
  const conv = getConversation(conversationId, true)
  if (!conv) return false
  return conv.messages.some((m) => m.messageId === messageId)
}

/** 句柄表：handleId → 字节源。Gateway 与协议层共享这一份。 */
const handles = new Map<string, PreviewHandle>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 读产物文件字节 + 版本指纹（artifact 用）。越界/缺失返回 null。 */
async function readArtifact(root: string, rel: string): Promise<
  { ok: true; buf?: Buffer; digest: string; mime: string; bytes: number; stamp: string }
  | { ok: false; errorCode: string; reason: string }
> {
  const abs = resolveInsideWorkspace(root, rel)
  if (!abs) return { ok: false, errorCode: 'forbidden', reason: '产物路径越出所属会话工作区' }
  try {
    const fd = await open(abs, 'r')
    try {
      const st = await fd.stat()
      if (!st.isFile()) throw new Error('不是文件')
      if (st.size > MAX_ASSET_BYTES) return { ok: false, errorCode: 'too-large', reason: '文件超过50MiB本地预览上限' }
      const mime = previewMimeOf(basename(rel))
      const caps = mime ? capabilitiesForMime(mime) : {}
      const chunks: Buffer[] = []
      const hash = createHash('sha256')
      const block = Buffer.alloc(1024 * 1024)
      let count = 0
      for (;;) {
        const { bytesRead } = await fd.read(block, 0, block.length, count)
        if (!bytesRead) break
        count += bytesRead
        if (count > MAX_ASSET_BYTES) return { ok: false, errorCode: 'too-large', reason: '读取期间文件增长超过50MiB，已拒绝' }
        const piece = block.subarray(0, bytesRead)
        hash.update(piece)
        if (!caps.media && !caps.pdf) chunks.push(Buffer.from(piece))
      }
      const after = await fd.stat()
      if (count !== st.size || fileSourceStamp(after) !== fileSourceStamp(st) || !resolveInsideWorkspace(root, rel)) throw new Error('源已变化')
      const buf = caps.media || caps.pdf ? undefined : Buffer.concat(chunks)
      const actualMime = mime ?? (buf?.subarray(0, 8192).includes(0) ? 'application/octet-stream' : 'text/plain')
      return { ok: true, ...(buf ? { buf } : {}), digest: hash.digest('hex').slice(0, 16), mime: actualMime, bytes: count, stamp: fileSourceStamp(st) }
    } finally { await fd.close() }
  } catch {
    return { ok: false, errorCode: 'not-found', reason: '产物不存在、无法读取或读取期间已变化' }
  }
}

/** 会话存在性 + 工作区绑定（从会话存储读，不信渲染端给的路径）。 */
function conversationExists(conversationId: string): boolean {
  return getConversation(conversationId) !== null
}
function conversationHasWorkspace(conversationId: string): boolean {
  const conv = getConversation(conversationId)
  return conv !== null && typeof conv.workspace === 'string' && conv.workspace.length > 0
}

/**
 * Gateway 与句柄表**惰性初始化**：`app.getPath` 只在首次打开预览时才调，
 * 不在模块求值期碰 electron —— 否则单测 mock 不全 electron 时，import 本模块就炸
 * （settings-window-ipc 等 IPC 测试实测：顶层 app.getPath 让整组收集失败）。
 */
let gateway: ReturnType<typeof createPreviewGateway> | null = null
function ensureGateway(): ReturnType<typeof createPreviewGateway> {
  if (gateway) return gateway
  const deps: PreviewGatewayDeps = {
    assetsRoot: assetsDir(app.getPath('userData')),
    conversationExists,
    conversationHasWorkspace,
    messageBelongsToConversation,
    messageReferencesAsset: (cid, mid, assetId) => {
      const message = getConversation(cid, true)?.messages.find(message => message.messageId === mid)
      return message?.localFiles?.some(file => file.assetId === assetId) === true
        || message?.parts?.some(part => part.type !== 'text' && part.ref === assetId) === true
    },
    draftAssetOwned: (owner, draftId, assetId) => identities.owns(owner, draftId, assetId),
    registerHandle: (handle) => {
      // 不可猜的句柄 id
      const id = randomBytes(16).toString('hex')
      handle.expiresAt = Date.now() + 5 * 60 * 1000
      handles.set(id, handle)
      const expiry = setTimeout(() => disposeHandle(id), 5 * 60 * 1000)
      expiry.unref()
      expiryTimers.set(id, expiry)
      return id
    },
    releaseHandle: (id) => {
      disposeHandle(id)
    }
  }
  gateway = createPreviewGateway(deps)
  return gateway
}

/** 打开预览：artifact 先读盘（async），再交 Gateway 裁定 + 拼预览 URL。 */
export async function openPreview(input: PreviewOpenInput, owner?: number): Promise<PreviewOpenOutput> {
  if (!owner || !observedOwners.has(owner)) return { ok: false, errorCode: 'forbidden', reason: '预览窗口已关闭或未登记' }
  let req = input
  // 已发送但renderer尚未重读时仍可能带draft。只以真实存档消息的那条资产边转换，
  // 不凭客户端source自报或全局存在性放行。重启也不需要恢复进程内草稿表。
  if ((input.source === 'history' || input.source === 'draft') && input.conversationId && input.messageId) {
    const message = getConversation(input.conversationId, true)?.messages.find(message => message.messageId === input.messageId)
    const part = message?.parts?.find(part => part.type !== 'text' && part.ref === input.assetId)
    const stored = message?.localFiles?.find(file => file.assetId === input.assetId)
      ?? (part && part.type !== 'text' ? { name: part.ref, mime: part.mime, bytes: part.bytes } : undefined)
    if (stored) req = { ...input, source: 'history', name: stored.name, mime: stored.mime, bytes: stored.bytes }
  }
  // 假conversation/message字段不能跳过草稿元数据核对；没有历史边仍走宿主草稿事实。
  if (req.source === 'draft' && req.assetId) {
    const metadata = identities.metadata(owner, req.draftId, req.assetId)
    if (metadata) req = { ...req, name: metadata.name, mime: metadata.mime, bytes: metadata.bytes }
  }
  // artifact：先在装配层读产物字节（Gateway 不读盘，见 preview-gateway 注释）
  let artifactBytes: Buffer | undefined
  let artifactDigest: string | undefined
  let artifactFile: { root: string; rel: string; bytes: number; stamp: string } | undefined
  if (req.source === 'artifact' && req.conversationId && req.workspaceRel) {
    const conv = getConversation(req.conversationId)
    const root = conv?.workspace
    if (root) {
      const art = await readArtifact(root, req.workspaceRel)
      if (!art.ok) return art
      if (art.ok) {
        artifactBytes = art.buf
        artifactDigest = art.digest
        req = { ...req, name: basename(req.workspaceRel!), mime: art.mime, bytes: art.bytes }
        artifactFile = { root, rel: req.workspaceRel!, bytes: art.bytes, stamp: art.stamp }
      }
    }
  }

  // artifact异步读盘期间窗口可能已销毁，不能签发新的孤儿句柄。
  if (!observedOwners.has(owner)) return { ok: false, errorCode: 'forbidden', reason: '预览窗口已关闭' }
  const res = ensureGateway().open({
    source: req.source as PreviewSourceKind,
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
    ...(req.messageId ? { messageId: req.messageId } : {}),
    ...(req.draftId ? { draftId: req.draftId } : {}),
    ...(req.assetId ? { assetId: req.assetId } : {}),
    ...(req.workspaceRel ? { workspaceRel: req.workspaceRel } : {}),
    name: req.name,
    mime: req.mime,
    ...(req.bytes !== undefined ? { bytes: req.bytes } : {}),
    ...(artifactBytes ? { artifactBytes } : {}),
    ...(artifactDigest ? { artifactDigest } : {}),
    ...(artifactFile ? { artifactFile } : {})
  }, owner)
  if (!res.ok || !res.handleId) {
    return { ok: false, ...(res.errorCode ? { errorCode: res.errorCode } : {}), ...(res.reason ? { reason: res.reason } : {}) }
  }

  // PDF由可信React组件＋本地worker画进浏览器canvas，不执行公共沙箱里的用户脚本。
  // Office复用已有纯Buffer解析器；解析出的静态HTML资源随这个句柄释放。
  let url = assetPreviewUrl(res.handleId)
  let degraded: string | undefined
  let officeSheets: { name: string; url: string }[] | undefined
  let officeClipped: boolean | undefined
  if (res.capabilities?.office) {
    const handle = handles.get(res.handleId)!
    const registerHtml = (html: string): string => {
      if (handles.get(res.handleId!) !== handle || (handle.expiresAt ?? 0) <= Date.now()) throw new Error('文档预览已经撤销')
      const token = memPreviews.register(html, () => handles.get(res.handleId!) === handle && (handle.expiresAt ?? 0) > Date.now())
      ;(handle.memTokens ??= []).push(token)
      return memPreviewUrl(token)
    }
    try {
      const bytes = handleBytes(handle)
      if (req.mime.includes('wordprocessingml')) url = registerHtml(await parseDocxBuffer(bytes))
      else {
        const book = parseSheetBuffer(bytes)
        officeSheets = book.sheets.map(sheet => ({ name: sheet.name, url: registerHtml(sheet.html) }))
        officeClipped = book.clipped
        if (officeSheets.length) url = officeSheets[0].url
        else degraded = '工作簿没有可预览的工作表'
      }
    } catch {
      degraded = 'Office解析失败：文件可能损坏或不是支持的格式'
    }
    // 异步docx解析期间关窗：不签发孤儿mem token，也不把已经撤销的句柄冒称成功。
    if (handles.get(res.handleId) !== handle) return { ok: false, errorCode: 'forbidden', reason: '预览窗口已关闭或句柄已撤销' }
  }

  return {
    ok: true,
    mime: req.mime,
    bytes: req.bytes ?? handles.get(res.handleId)?.bytes,
    name: req.name,
    handleId: res.handleId,
    url,
    ...(degraded ? { degraded } : {}),
    ...(officeSheets ? { officeSheets } : {}),
    ...(officeClipped !== undefined ? { officeClipped } : {}),
    ...(res.capabilities ? { capabilities: res.capabilities as PreviewCapabilities } : {}),
    ...(res.sourceLabel ? { sourceLabel: res.sourceLabel } : {}),
    ...(res.sourceVersion ? { sourceVersion: res.sourceVersion } : {}),
    ...(res.boundedText !== undefined ? { boundedText: res.boundedText } : {}),
    ...(res.truncated !== undefined ? { truncated: res.truncated } : {})
  }
}

/** 句柄只指向已裁定的源，再读时仍核物理边界，不采用renderer自报路径。 */
function handleBytes(handle: PreviewHandle): Buffer {
  if (handle.bytes > MAX_ASSET_BYTES) throw new Error('文件超过50MiB预览上限')
  const bytes = handle.buf ?? (handle.assetsRoot && handle.assetId ? readAsset(handle.assetsRoot, handle.assetId) : readFileSync(previewFileSource(handle).path))
  if (!bytes || bytes.length > MAX_ASSET_BYTES) throw new Error('预览源缺失或超过上限')
  return bytes
}

/** 释放预览句柄（幂等）。 */
export function releasePreview(handleId: string, owner?: number): void {
  const handle = handles.get(handleId)
  if (!handle || handle.ownerId !== owner) return
  disposeHandle(handleId)
}

function disposeHandle(handleId: string): void {
  const expiry = expiryTimers.get(handleId)
  if (expiry) clearTimeout(expiry)
  expiryTimers.delete(handleId)
  const handle = handles.get(handleId)
  for (const token of handle?.memTokens ?? []) memPreviews.release(token)
  for (const stream of handle?.streams ?? []) stream.destroy()
  handles.delete(handleId)
}

/** 只让签发窗口读取自己的有效PDF句柄，字节通过受控桥进入宿主绘制代码。 */
export function readPreview(handleId: string, owner: number): Uint8Array {
  const handle = handles.get(handleId)
  if (!handle || handle.ownerId !== owner || !handle.expiresAt || handle.expiresAt <= Date.now()) {
    if (handle?.expiresAt && handle.expiresAt <= Date.now()) disposeHandle(handleId)
    throw new Error('预览句柄已失效或不属于此窗口')
  }
  if (handle.mime !== 'application/pdf') throw new Error('该句柄不属于宿主PDF绘制通路')
  return new Uint8Array(handleBytes(handle))
}

/** 仅用户主动点击：按本人有效句柄开原会话当前文件或附件副本，不用当前全局工作区。 */
export async function openPreviewInSystem(handleId: string, owner: number): Promise<{ ok: boolean; error?: string }> {
  const handle = handles.get(handleId)
  if (!handle || handle.ownerId !== owner || !handle.expiresAt || handle.expiresAt <= Date.now()) return { ok: false, error: '预览句柄已失效或不属于此窗口' }
  try {
    const source = previewFileSource(handle)
    if (/\.(?:exe|com|msi|bat|cmd|ps1|vbs|scr|lnk|url|hta)$/i.test(source.path)) return { ok: false, error: '预览通路不启动可执行文件或快捷方式' }
    const error = await shell.openPath(source.path)
    return error ? { ok: false, error: '系统程序无法打开该文件' } : { ok: true }
  } catch { return { ok: false, error: '文件已变化、缺失或越界，请重新打开预览' } }
}

/** 发送前摄取外部文件到资产库（工作区外显式导入）。 */
export function ingestDraft(input: PreviewIngestInput, owner?: number): PreviewIngestOutput {
  if (!owner) return { ok: false, reason: '草稿缺少可信窗口身份' }
  const root = assetsDir(app.getPath('userData'))
  const name = basename(input.sourceAbs)
  let draftId: string | undefined
  const res = ingestAsset(input.sourceAbs, name, root, getAssetBudget(), asset => {
    const file = identities.register(owner, { ...asset, name, mime: previewMimeOf(name) ?? 'application/octet-stream', outside: true })
    draftId = file.draftId
    return () => identities.revokeDraft(file.draftId)
  })
  if (!res.ok) return { ok: false, reason: res.reason }
  log.info('草稿附件已摄取', { assetId: res.asset.assetId, bytes: res.asset.bytes })
  return { ok: true, assetId: res.asset.assetId, bytes: res.asset.bytes, digest: res.asset.digest, draftId }
}

/** 句柄表（供协议层 installAssetPreviewProtocol 消费）。 */
export function previewHandles(): Map<string, PreviewHandle> {
  return handles
}

/** 启动时把已落盘资产计入预算占用（未知旧资产保守保留，不删）。 */
export function seedBudgetFromDisk(): void {
  getAssetBudget()
}
