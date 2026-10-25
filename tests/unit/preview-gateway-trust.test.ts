// 受信加载缝的命名断言（plan74 第三组，对应 Spec R3 反例 3/4）。
// 直接 import 真实 Gateway + 真实 readAsset，喂真实夹具 —— 不用假数据、不 mock 规则。
// 先红后绿：修前缺会话/伪消息/未登记草稿放行、junction 越界可读（审查端反例实测坐实）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreviewGateway, type PreviewGatewayDeps, type PreviewHandle } from '../../src/main/preview-gateway'
import { readAsset } from '../../src/main/preview-assets'
import { isSafeAssetId } from '../../src/shared/conversation-preview'

let root: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pv-gw-'))
  outside = mkdtempSync(join(tmpdir(), 'pv-out-'))
  // 合法形状的资产文件（日期-序号-hex.ext）
  writeFileSync(join(root, '20261014T120000-0-abc123.txt'), 'OWNED_CONTENT')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function makeDeps(overrides: Partial<PreviewGatewayDeps> = {}): PreviewGatewayDeps {
  const handles = new Map<string, PreviewHandle>()
  return {
    assetsRoot: root,
    conversationExists: (id) => id === 'conv-A',
    conversationHasWorkspace: (id) => id === 'conv-A',
    messageBelongsToConversation: (conv, msg) => conv === 'conv-A' && msg === 'msg-1',
    messageReferencesAsset: (conv, msg, assetId) => conv === 'conv-A' && msg === 'msg-1' && assetId === '20261014T120000-0-abc123.txt',
    draftAssetOwned: () => false,
    registerHandle: (h) => {
      const id = `h-${handles.size}`
      handles.set(id, h)
      return id
    },
    releaseHandle: (id) => {
      handles.delete(id)
    },
    ...overrides
  }
}

describe('受信加载缝：身份核（R3 反例3）', () => {
  it('history 缺会话身份 → 拒（修前放行）', () => {
    const gw = createPreviewGateway(makeDeps())
    const r = gw.open({ source: 'history', assetId: '20261014T120000-0-abc123.txt', name: 'a.txt', mime: 'text/plain' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('bad-request')
  })

  it('history 会话存在但消息不归属 → 拒（修前放行）', () => {
    const gw = createPreviewGateway(makeDeps())
    const r = gw.open({
      source: 'history',
      conversationId: 'conv-A',
      messageId: 'msg-FORGED',
      assetId: '20261014T120000-0-abc123.txt',
      name: 'a.txt',
      mime: 'text/plain'
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('forbidden')
  })

  it('history 合法身份 → 放行', () => {
    const gw = createPreviewGateway(makeDeps())
    const r = gw.open({
      source: 'history',
      conversationId: 'conv-A',
      messageId: 'msg-1',
      assetId: '20261014T120000-0-abc123.txt',
      name: 'a.txt',
      mime: 'text/plain'
    })
    expect(r.ok).toBe(true)
    expect(r.boundedText).toContain('OWNED_CONTENT')
  })

  it('draft 未宿主摄取的 assetId → 拒（修前放行）', () => {
    const gw = createPreviewGateway(makeDeps())
    // 该 assetId 没经 ingestAsset 登记（hostIngested 集不含它）
    const r = gw.open({ source: 'draft', assetId: '20261014T120000-0-abc123.txt', name: 'a.txt', mime: 'text/plain' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('forbidden')
  })
})

describe('readAsset 真实边界：junction 越界拒读（R3 反例4）', () => {
  it('目录联接指向根外 → 抛越界（修前成功读到 OUTSIDE_SENTINEL）', ({ skip }) => {
    // 在资产根里放一个指向外部的联接（symlink；Windows junction 同族）
    const assetId = '20261014T120000-1-abc124.txt'
    expect(isSafeAssetId(assetId)).toBe(true)
    const linkPath = join(root, assetId)
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL')
    try {
      symlinkSync(join(outside, 'secret.txt'), linkPath, 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
      console.log(`PREVIEW_SYMLINK_SKIP=${JSON.stringify({ code, reason: '当前身份无文件符号链接创建权限' })}`)
      skip()
      return
    }
    expect(readFileSync(linkPath, 'utf8')).toBe('OUTSIDE_SENTINEL')
    expect(() => readAsset(root, assetId)).toThrow(/越界|无法解析/)
  })

  it('根内正常文件 → 可读', () => {
    const buf = readAsset(root, '20261014T120000-0-abc123.txt')
    expect(buf.toString()).toBe('OWNED_CONTENT')
  })
})
