// 草稿能力由宿主签发并绑定真实窗口；持久历史的真源是原会话中那条消息的资产引用。
// 保存前只校验/规整，落盘成功后才消费草稿。失败重试不会丢能力，也不重复制资产。
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '@shared/ipc'
import type { LocalFileRef } from '@shared/conversation-preview'

export type PreviewAssetMetadata = Pick<LocalFileRef, 'assetId' | 'name' | 'mime' | 'bytes' | 'digest' | 'outside'>

export class PreviewIdentities {
  private readonly drafts = new Map<string, { owner: number; file: PreviewAssetMetadata }>()

  register(owner: number, file: PreviewAssetMetadata): LocalFileRef & { draftId: string } {
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('草稿缺少可信窗口身份')
    const draftId = randomUUID()
    this.drafts.set(draftId, { owner, file: { ...file } })
    return { ...file, source: 'draft', draftId }
  }

  owns(owner: number | undefined, draftId: string | undefined, assetId: string): boolean {
    const entry = draftId ? this.drafts.get(draftId) : undefined
    return entry !== undefined && entry.owner === owner && entry.file.assetId === assetId
  }

  metadata(owner: number | undefined, draftId: string | undefined, assetId: string): PreviewAssetMetadata | null {
    return this.owns(owner, draftId, assetId) ? { ...this.drafts.get(draftId!)!.file } : null
  }

  revokeOwner(owner: number): void {
    for (const [id, entry] of this.drafts) if (entry.owner === owner) this.drafts.delete(id)
  }

  revokeDraft(draftId: string): void { this.drafts.delete(draftId) }

  /** existing来自宿主存档，incoming来自可信IPC请求但引用字段仍不作为授权事实。 */
  prepare(incoming: ChatMessage[], existing: ChatMessage[], owner: number): ChatMessage[] {
    const seen = new Set<string>()
    return incoming.map(message => {
      if (message.messageId) {
        if (seen.has(message.messageId)) throw new Error('消息身份重复，已拒绝保存')
        seen.add(message.messageId)
      }
      if (!message.localFiles?.length) return message
      if (!message.messageId) throw new Error('本地附件缺少稳定消息身份')
      const previous = existing.find(m => m.messageId === message.messageId && m.role === message.role)
      const localFiles = message.localFiles.map(file => {
        const stored = previous?.localFiles?.find(ref => ref.assetId === file.assetId)
        const metadata = stored ?? this.metadata(owner, file.draftId, file.assetId)
        if (!metadata) throw new Error('附件未登记或不属于这条消息，已拒绝保存')
        // 不持久化临时窗口能力；只保存宿主/原消息的展示事实，渲染层不能改MIME提升能力。
        return {
          assetId: metadata.assetId, name: metadata.name, mime: metadata.mime, bytes: metadata.bytes,
          ...(metadata.digest ? { digest: metadata.digest } : {}),
          ...(metadata.outside !== undefined ? { outside: metadata.outside } : {}),
          source: 'history' as const
        }
      })
      return { ...message, localFiles }
    })
  }

  committed(messages: ChatMessage[], owner: number): void {
    const assets = new Set(messages.flatMap(message => message.localFiles?.map(file => file.assetId) ?? []))
    for (const [id, entry] of this.drafts) {
      if (entry.owner === owner && assets.has(entry.file.assetId)) this.drafts.delete(id)
    }
  }
}
