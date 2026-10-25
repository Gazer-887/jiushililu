import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreviewGateway, type PreviewHandle } from '../../src/main/preview-gateway'
import { installPreviewProtocol } from '../../src/main/preview-protocol'

const hook = vi.hoisted(() => ({ handler: null as null | ((request: Request) => Promise<Response>), forbidFullRead: false, ranges: [] as { start?: number; end?: number; highWaterMark?: number }[] }))
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, handler: typeof hook.handler) => { hook.handler = handler } } }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (hook.forbidFullRead) throw new Error('测试拒绝整份读取媒体')
      return fs.readFileSync(...args)
    },
    createReadStream: (path: Parameters<typeof fs.createReadStream>[0], options: Parameters<typeof fs.createReadStream>[1]) => {
      hook.ranges.push(typeof options === 'object' ? options : {})
      return fs.createReadStream(path, options)
    }
  }
})
const roots: string[] = []
const id = '20261014T120000-0-aabbcc.wav'
function fixture(): { handles: Map<string, PreviewHandle>; url: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'jsl-preview-range-')); roots.push(root)
  const dir = join(root, 'assets'); mkdirSync(dir)
  writeFileSync(join(dir, id), Buffer.from(Array.from({ length: 4096 }, (_, n) => n % 256)))
  const handles = new Map<string, PreviewHandle>()
  const gateway = createPreviewGateway({ assetsRoot: dir, conversationExists: () => true, conversationHasWorkspace: () => true,
    messageBelongsToConversation: () => true, messageReferencesAsset: () => true, draftAssetOwned: () => true,
    registerHandle: handle => { handles.set('a'.repeat(32), handle); return 'a'.repeat(32) }, releaseHandle: key => { handles.delete(key) } })
  const opened = gateway.open({ source: 'history', conversationId: 'c', messageId: 'm', assetId: id, name: 'sound.wav', mime: 'audio/wav' }, 1)
  expect(opened.ok).toBe(true)
  installPreviewProtocol(() => root, handles)
  return { handles, root, url: `jsl-preview://asset/${opened.handleId}` }
}
afterEach(() => { hook.forbidFullRead = false; hook.ranges.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('生产协议按真实区间读取媒体', () => {
  it('Gateway打开与Range响应均不整份读媒体，真实64字节回应', async () => {
    hook.forbidFullRead = true
    const { url } = fixture()
    const response = await hook.handler!(new Request(url, { headers: { Range: 'bytes=1024-1087' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 1024-1087/4096')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from({ length: 64 }, (_, n) => n))
    expect(hook.ranges).toContainEqual(expect.objectContaining({ start: 1024, end: 1087, highWaterMark: 64 * 1024 }))
  })
  it('无Range也经有背压的文件流；多段与越界416不打开流', async () => {
    const { url } = fixture()
    hook.forbidFullRead = true
    for (const range of ['bytes=0-1,3-5', 'bytes=5000-']) {
      const response = await hook.handler!(new Request(url, { headers: { Range: range } }))
      expect(response.status).toBe(416)
    }
    expect(hook.ranges).toHaveLength(0)
    const response = await hook.handler!(new Request(url))
    expect((await response.arrayBuffer()).byteLength).toBe(4096)
    expect(hook.ranges).toHaveLength(1)
  })
  it('浏览器取消读取会释放实际文件流', async () => {
    const { url, handles } = fixture()
    const response = await hook.handler!(new Request(url))
    const streams = handles.get('a'.repeat(32))?.streams
    expect(streams?.size).toBe(1)
    await response.body!.cancel()
    await vi.waitFor(() => expect(streams?.size).toBe(0))
  })
})
