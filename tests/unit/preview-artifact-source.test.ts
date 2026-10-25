import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { observePreviewOwner, openPreview, openPreviewInSystem, releasePreview, previewHandles } from '../../src/main/preview-assemble'
const state = vi.hoisted(() => ({ root: '', opened: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, shell: { openPath: async (path: string) => { state.opened.push(path); return '' } } }))
vi.mock('../../src/main/store/conversations', () => ({ getConversation: (id: string) => id === 'owned' ? { workspace: state.root, messages: [] } : null }))
const roots: string[] = []
const sender = { id: 9, isDestroyed: () => false, once: () => {} } as unknown as WebContents
afterEach(() => { state.opened.length = 0; for (const [id, h] of previewHandles()) releasePreview(id, h.ownerId); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() { state.root = mkdtempSync(join(tmpdir(), 'jsl-artifact-source-')); roots.push(state.root); observePreviewOwner(sender); return state.root }
describe('产物展示事实由宿主补探', () => {
  it('系统打开仅从本人有效句柄取真实源，拒绝他窗/撤销和可执行文件', async () => {
    const root = fixture(); writeFileSync(join(root, 'document.pptx'), Buffer.from('PK\u0000LOCAL_DOCUMENT'))
    const request = { source: 'artifact' as const, conversationId: 'owned', workspaceRel: 'document.pptx', name: 'document.pptx', mime: 'text/plain' }
    const result = await openPreview(request, sender.id)
    expect(await openPreviewInSystem(result.handleId!, sender.id + 1)).toMatchObject({ ok: false })
    expect(state.opened).toHaveLength(0)
    expect(await openPreviewInSystem(result.handleId!, sender.id)).toEqual({ ok: true })
    expect(state.opened).toEqual([join(root, 'document.pptx')])
    releasePreview(result.handleId!, sender.id)
    expect(await openPreviewInSystem(result.handleId!, sender.id)).toMatchObject({ ok: false })
    writeFileSync(join(root, 'program.exe'), Buffer.from('MZ\u0000PROGRAM'))
    const executable = await openPreview({ ...request, workspaceRel: 'program.exe', name: 'program.exe' }, sender.id)
    expect(await openPreviewInSystem(executable.handleId!, sender.id)).toMatchObject({ ok: false, error: expect.stringContaining('可执行') })
    expect(state.opened).toHaveLength(1)
  })
  it('不吃客户端mime/大小，真实音频按原工作区流式句柄供给', async () => {
    const root = fixture(); writeFileSync(join(root, 'actual.wav'), Buffer.alloc(1024))
    const result = await openPreview({ source: 'artifact', conversationId: 'owned', workspaceRel: 'actual.wav', name: 'fake.png', mime: 'image/png', bytes: 0 }, sender.id)
    expect(result.capabilities?.media).toBe(true)
    expect(result.capabilities?.image).toBeFalsy()
    expect(result.mime).toBe('audio/wav')
    expect(result.bytes).toBe(1024)
    const handle = previewHandles().get(result.handleId!)!
    expect(handle.kind).toBe('stream')
    expect(handle.buf).toBeUndefined()
    expect(handle.workspaceRoot).toBe(root)
  })
  it('同长度内容变更刷新获得不同指纹和当前内容，不按mtime猜版本', async () => {
    const root = fixture(); writeFileSync(join(root, 'version.txt'), 'VERSION_ONE')
    const request = { source: 'artifact' as const, conversationId: 'owned', workspaceRel: 'version.txt', name: 'version.txt', mime: 'text/plain' }
    const one = await openPreview(request, sender.id)
    writeFileSync(join(root, 'version.txt'), 'VERSION_TWO')
    const two = await openPreview(request, sender.id)
    expect(two.sourceVersion).not.toBe(one.sourceVersion)
    expect(two.boundedText).toBe('VERSION_TWO')
  })
  it('真实产物50MiB+1字节明确超限，不整份读取并伪称缺失', async () => {
    const root = fixture(); writeFileSync(join(root, 'large.pdf'), Buffer.alloc(50 * 1024 * 1024 + 1))
    const result = await openPreview({ source: 'artifact', conversationId: 'owned', workspaceRel: 'large.pdf', name: 'large.pdf', mime: 'application/pdf' }, sender.id)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('too-large')
    expect(result.reason).toContain('50MiB')
  })
})
