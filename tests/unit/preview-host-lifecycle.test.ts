// 真正装配的句柄/登记生命周期，仅替Electron窗口与会话查询外设。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import type { WebContents } from 'electron'
let assembly: typeof import('../../src/main/preview-assemble')
beforeEach(async () => { vi.resetModules(); assembly = await import('../../src/main/preview-assemble') })
import { AssetBudget } from '../../src/main/preview-assets'
import { readAttachment, type AttachmentPublisher } from '../../src/main/workspace-fs'
const state = vi.hoisted(() => ({ data: '', pngBytes: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => state.data }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 3, height: 2 }), isEmpty: () => false, toPNG: () => state.pngBytes ? Buffer.alloc(state.pngBytes) : Buffer.from('NORMALIZED_PNG') }) } }))
vi.mock('../../src/main/store/conversations', () => ({ getConversation: () => null }))
const roots: string[] = []
let ownerId = 1000
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-host-lifetime-')); roots.push(root); state.data = root
  let destroyed = false
  let close: () => void = () => {}
  const sender = { id: ++ownerId, isDestroyed: () => destroyed, once: (_event: string, cb: () => void) => { close = cb } } as unknown as WebContents
  return { root, sender, destroy: () => { destroyed = true; close() } }
}
afterEach(() => { state.pngBytes = 0; vi.useRealTimers(); for (const [id, h] of assembly.previewHandles()) assembly.releasePreview(id, h.ownerId); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('宿主登记与生命周期不是报告口径', () => {
  it('转换后的粘贴图超过5MiB仍可在本地50MiB范围保存，但不生成模型image parts', () => {
    const f = fixture(); state.pngBytes = 5 * 1024 * 1024 + 1
    const attachment = assembly.ingestClipboardImage(new Uint8Array([1]), f.sender)
    expect(attachment.image).toBeUndefined()
    expect(attachment.preview?.draftId).toBeTruthy()
    expect(attachment.bytes).toBe(state.pngBytes)
    expect(readdirSync(join(f.root, 'assets'))).toHaveLength(1)
    f.destroy()
  })
  it('粘贴复用同一字节库和宿主身份；仅图像解码外设替身，真实解码另由Electron故事证实', async () => {
    const f = fixture()
    const attachment = assembly.ingestClipboardImage(new Uint8Array([1]), f.sender)
    expect(attachment.preview?.assetId).toBe(attachment.image?.ref)
    expect(attachment.bytes).toBe(Buffer.byteLength('NORMALIZED_PNG'))
    const result = await assembly.openPreview({ ...attachment.preview!, source: 'draft', name: attachment.name, mime: 'image/png' }, f.sender.id)
    expect(result.ok).toBe(true)
    expect(readdirSync(join(f.root, 'attachments'))).toHaveLength(1)
    f.destroy()
    expect(assembly.previewHandles().has(result.handleId!)).toBe(false)
  })
  it('空粘贴/50MiB+1/已关闭窗口拒绝，不产生附件文件', () => {
    const f = fixture()
    expect(() => assembly.ingestClipboardImage(new Uint8Array(), f.sender)).toThrow()
    expect(() => assembly.ingestClipboardImage(new Uint8Array(50 * 1024 * 1024 + 1), f.sender)).toThrow()
    f.destroy()
    expect(() => assembly.ingestClipboardImage(new Uint8Array([1]), f.sender)).toThrow(/窗口已关闭/)
    expect(readdirSync(f.root)).not.toContain('attachments')
  })
  it('实际窗口在异步摄取期间销毁，拒绝登记且没有占用/文件', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'closed.pdf'), '%PDF-TEST')
    const budget = new AssetBudget()
    const publisher = assembly.attachmentPreviewPublisher(f.sender)
    const pending = readAttachment(f.root, 'closed.pdf', f.root, budget, publisher)
    f.destroy()
    await expect(pending).rejects.toThrow(/无法加入预览/)
    expect(budget.usedBytes).toBe(0)
    expect(readdirSync(join(f.root, 'assets'))).toHaveLength(0)
  })
  it('到期主动撤销句柄并停止实际在途流，窗口不用再请求才清理', async () => {
    vi.useFakeTimers()
    const f = fixture(); assembly.observePreviewOwner(f.sender)
    writeFileSync(join(f.root, 'owned.wav'), 'LOCAL_MEDIA_BYTES')
    const ingested = assembly.ingestDraft({ sourceAbs: join(f.root, 'owned.wav'), name: 'owned.wav', mime: 'audio/wav', draftId: 'client-not-trusted' }, f.sender.id)
    const result = await assembly.openPreview({ ...ingested, source: 'draft', name: 'owned.wav', mime: 'audio/wav' }, f.sender.id)
    expect(result.ok).toBe(true)
    const stream = new PassThrough()
    const handle = assembly.previewHandles().get(result.handleId!)!
    handle.streams = new Set([stream as never])
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    expect(assembly.previewHandles().has(result.handleId!)).toBe(false)
    expect(stream.destroyed).toBe(true)
    f.destroy()
  })
  it('文本hint文件前8KiB含NUL：正文为空并按未知二进制降级，本地快照与身份保留', async () => {
    const f = fixture()
    const budget = new AssetBudget()
    const publisher = assembly.attachmentPreviewPublisher(f.sender)
    // 独立审查 N-1 反例同形：文本扩展名 + 带 NUL 的二进制内容（独特哨兵头 + NUL + 哨兵尾）。
    const binaryLookingText = Buffer.concat([
      Buffer.from('BINHEAD'),
      Buffer.alloc(4, 0),
      Buffer.from('NULFAKE_BINARY_TAIL_SENTINEL')
    ])
    for (const name of ['fake.log', 'fake.txt', 'fake.json', 'fake.xml', 'fake.md', 'fake.csv']) {
      writeFileSync(join(f.root, name), binaryLookingText)
      const a = await readAttachment(f.root, name, f.root, budget, publisher)
      // 正文必须为空：不许把 NUL 二进制垃圾正文送进模型上下文
      expect(a.content, name).toBe('')
      expect(a.image, name).toBeUndefined()
      expect(a.video, name).toBeUndefined()
      // 本地快照与合法归属保留（不删用户文件，不伪造图片/视频 parts）
      expect(a.preview?.assetId, name).toBeTruthy()
      expect(a.preview?.draftId, name).toBeTruthy()
      expect(a.bytes, name).toBe(binaryLookingText.length)
    }
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(join(f.root, 'assets')).length).toBe(6)
    expect(readFileSync(join(f.root, 'fake.log'))).toEqual(binaryLookingText)
    f.destroy()
  })
  it('文本hint文件无NUL（含中文）：仍给正确正文与64KiB截断，行为不变', async () => {
    const f = fixture()
    const budget = new AssetBudget()
    const publisher = assembly.attachmentPreviewPublisher(f.sender)
    writeFileSync(join(f.root, 'plain.txt'), '普通中文文本 HELLO', 'utf8')
    const ok = await readAttachment(f.root, 'plain.txt', f.root, budget, publisher)
    expect(ok.content).toBe('普通中文文本 HELLO')
    expect(ok.truncated).toBe(false)
    writeFileSync(join(f.root, 'long.log'), 'x'.repeat(70 * 1024), 'utf8')
    const long = await readAttachment(f.root, 'long.log', f.root, budget, publisher)
    expect(long.truncated).toBe(true)
    expect(long.content.length).toBe(64 * 1024)
    f.destroy()
  })
  it('真实PDF/图片不因容器含NUL被误拒；publish失败不留假登记', async () => {
    const f = fixture()
    const budget = new AssetBudget()
    // 真实 PDF：合法 PDF 头 + 含 NUL 的二进制流（PDF 本就含 NUL，不能因此误拒）
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n'), Buffer.from([0, 0, 0, 0]), Buffer.from('%%EOF')])
    writeFileSync(join(f.root, 'doc.pdf'), pdfBytes)
    const pdf = await readAttachment(f.root, 'doc.pdf', f.root, budget, assembly.attachmentPreviewPublisher(f.sender))
    expect(pdf.preview?.assetId).toBeTruthy()
    expect(pdf.content).toBe('')
    // 真实图片：含 NUL 的 PNG 仍走图片 parts 通路
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(f.root, 'real.png'), png)
    const img = await readAttachment(f.root, 'real.png', f.root, budget, assembly.attachmentPreviewPublisher(f.sender))
    expect(img.image?.mime).toBe('image/png')
    expect(img.content).toBe('')
    // publish 失败不留假登记
    const failing: AttachmentPublisher = () => { throw new Error('OWNER_WINDOW_CLOSED') }
    writeFileSync(join(f.root, 'will-fail.txt'), 'some text')
    await expect(readAttachment(f.root, 'will-fail.txt', f.root, budget, failing)).rejects.toThrow()
    expect(budget.usedBytes).toBe(pdf.bytes + png.length)
    f.destroy()
  })
})
