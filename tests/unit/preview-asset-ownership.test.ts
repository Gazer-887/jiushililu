// 必须拿真实存在的资产作反例，不能靠“文件不存在”假绿。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetBudget, ingestAsset } from '../../src/main/preview-assets'
import { createPreviewGateway } from '../../src/main/preview-gateway'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-asset-owner-'))
  roots.push(root)
  const source = join(root, 'owned.txt')
  writeFileSync(source, 'OWNED_ASSET_SENTINEL')
  const assets = join(root, 'assets')
  const ingested = ingestAsset(source, 'owned.txt', assets, new AssetBudget())
  if (!ingested.ok) throw new Error('夹具摄取失败')
  const assetId = ingested.asset.assetId
  const gateway = createPreviewGateway({
    assetsRoot: assets, conversationExists: id => ['a', 'b'].includes(id),
    conversationHasWorkspace: () => true,
    messageBelongsToConversation: (_cid, mid) => mid === 'owned-message',
    messageReferencesAsset: (cid, mid, aid) => cid === 'a' && mid === 'owned-message' && aid === assetId,
    draftAssetOwned: (owner, draft, aid) => owner === 7 && draft === 'host-draft' && aid === assetId,
    registerHandle: () => 'owned-handle', releaseHandle: () => {}
  })
  return { gateway, assetId }
}

describe('宿主登记关系裁定预览，不只核“存在”', () => {
  it('合法会话和合法消息，但消息未引用这个真实资产：明确forbidden', () => {
    const { gateway, assetId } = fixture()
    const result = gateway.open({ source: 'history', conversationId: 'b', messageId: 'owned-message', assetId, name: 'owned.txt', mime: 'text/plain' }, 7)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('forbidden')
  })
  it('实际登记草稿配错draftId：明确forbidden', () => {
    const { gateway, assetId } = fixture()
    const result = gateway.open({ source: 'draft', draftId: 'forged-draft', assetId, name: 'owned.txt', mime: 'text/plain' }, 7)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('forbidden')
  })
  it('真实草稿被另一可信窗口读取：明确forbidden', () => {
    const { gateway, assetId } = fixture()
    const result = gateway.open({ source: 'draft', draftId: 'host-draft', assetId, name: 'owned.txt', mime: 'text/plain' }, 8)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('forbidden')
  })
  it('草稿身份缺失：拒绝，而非进程级Set放行', () => {
    const { gateway, assetId } = fixture()
    expect(gateway.open({ source: 'draft', assetId, name: 'owned.txt', mime: 'text/plain' }, 7).ok).toBe(false)
  })
  it('合法草稿和合法历史各有正向读取', () => {
    const { gateway, assetId } = fixture()
    const draft = gateway.open({ source: 'draft', draftId: 'host-draft', assetId, name: 'owned.txt', mime: 'text/plain' }, 7)
    const history = gateway.open({ source: 'history', conversationId: 'a', messageId: 'owned-message', assetId, name: 'owned.txt', mime: 'text/plain' }, 7)
    expect(draft.boundedText).toBe('OWNED_ASSET_SENTINEL')
    expect(history.boundedText).toBe('OWNED_ASSET_SENTINEL')
  })
})
