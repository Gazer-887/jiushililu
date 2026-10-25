import { describe, expect, it } from 'vitest'
import { PreviewIdentities } from '../../src/main/preview-identities'
import type { ChatMessage } from '../../src/shared/ipc'

const metadata = { assetId: '20261014T120000-0-abc123.txt', name: 'owned.txt', mime: 'text/plain', bytes: 10, digest: 'a'.repeat(16) }

describe('草稿到历史绑定的宿主真源', () => {
  it('只有登记窗口与宿主draftId能读取；窗口销毁使草稿失效', () => {
    const identities = new PreviewIdentities()
    const file = identities.register(7, metadata)
    expect(identities.owns(7, file.draftId, file.assetId)).toBe(true)
    expect(identities.owns(8, file.draftId, file.assetId)).toBe(false)
    expect(identities.owns(7, 'forged', file.assetId)).toBe(false)
    identities.revokeOwner(7)
    expect(identities.owns(7, file.draftId, file.assetId)).toBe(false)
  })
  it('准备保存只规整，不消费草稿；失败可重试，成功后仅已落盘历史可再保存', () => {
    const identities = new PreviewIdentities()
    const file = identities.register(7, metadata)
    const request: ChatMessage[] = [{ role: 'user', content: 'hello', messageId: 'u-owned', localFiles: [file] }]
    const prepared = identities.prepare(request, [], 7)
    expect(prepared[0].localFiles?.[0]).toEqual({ ...metadata, source: 'history' })
    expect(identities.owns(7, file.draftId, file.assetId)).toBe(true)
    identities.committed(prepared, 7)
    expect(identities.owns(7, file.draftId, file.assetId)).toBe(false)
    expect(identities.prepare(request, prepared, 7)[0].localFiles).toEqual(prepared[0].localFiles)
    expect(() => identities.prepare(request, [], 7)).toThrow(/未登记|不属于/)
  })
  it('重启后无进程内草稿也能依据原消息资产边保存，不能移到另一条合法消息', () => {
    const identities = new PreviewIdentities()
    const old: ChatMessage[] = [{ role: 'user', content: 'hello', messageId: 'u-owned', localFiles: [{ ...metadata, source: 'history' }] }]
    expect(identities.prepare(old, old, 7)[0].localFiles?.[0].source).toBe('history')
    expect(() => identities.prepare([{ ...old[0], messageId: 'u-other' }], old, 7)).toThrow(/未登记|不属于/)
  })
  it('接收端改名、改MIME、改大小不改变宿主保存的事实；未知token拒绝', () => {
    const identities = new PreviewIdentities()
    const file = identities.register(7, metadata)
    const message: ChatMessage = { role: 'user', content: 'x', messageId: 'u-owned', localFiles: [{ ...file, name: 'evil.html', mime: 'text/html', bytes: 1 }] }
    expect(identities.prepare([message], [], 7)[0].localFiles?.[0]).toEqual({ ...metadata, source: 'history' })
    expect(() => identities.prepare([{ ...message, localFiles: [{ ...file, draftId: 'forged' }] }], [], 7)).toThrow(/未登记|不属于/)
  })
  it('显式历史身份不能授权新消息，重复消息身份不能串资产', () => {
    const identities = new PreviewIdentities()
    const history = { ...metadata, source: 'history' as const }
    expect(() => identities.prepare([{ role: 'user', content: 'x', messageId: 'u-new', localFiles: [history] }], [], 7)).toThrow()
    const draft = identities.register(7, metadata)
    const message: ChatMessage = { role: 'user', content: 'x', messageId: 'u-dup', localFiles: [draft] }
    expect(() => identities.prepare([message, message], [], 7)).toThrow(/重复/)
  })
})
