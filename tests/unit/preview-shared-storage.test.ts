// 两个物理目录必须共用容量和读取规则；均为本用例自己的临时文件。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetBudget, assetsDir, assetBudgetForRoot, ingestAsset, readAsset } from '../../src/main/preview-assets'
import { attachmentsDir, saveAttachmentImage, readAttachmentMedia } from '../../src/main/attachments-store'
import { readAttachment } from '../../src/main/workspace-fs'

const roots: string[] = []
const fault = vi.hoisted(() => ({ externalPath: '', enabled: false, missingOnStat: '', deniedRealpath: '' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]) === fault.missingOnStat) { fs.rmSync(args[0]); throw Object.assign(new Error('removed while scanning'), { code: 'ENOENT' }) }
      return fs.statSync(...args)
    },
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) => {
      if (String(args[0]) === fault.deniedRealpath) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fs.realpathSync(...args)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (fault.enabled) {
      fault.externalPath = String(args[1])
      fs.writeFileSync(args[1], 'EXTERNAL_FILE_SENTINEL')
      throw new Error('OWNED_RENAME_FAILURE')
    }
    return fs.renameSync(...args)
  } }
})
function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'jsl-shared-assets-')); roots.push(root); return root }
afterEach(() => { fault.enabled = false; fault.missingOnStat = ''; fault.deniedRealpath = ''; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('新旧媒体与本地预览共用一份物理字节', () => {
  it('原attachments媒体通过本地预览读取，不迁移也不复制', () => {
    const root = fixture()
    const media = saveAttachmentImage(root, { mime: 'image/png', buf: Buffer.from('REAL_MEDIA_BYTES'), now: () => new Date() })!
    expect(readAsset(assetsDir(root), media.ref).toString()).toBe('REAL_MEDIA_BYTES')
  })
  it('assets目录中的媒体同样可物化成原模型parts，不复制到旧库', () => {
    const root = fixture()
    const source = join(root, 'image.png')
    writeFileSync(source, 'SHARED_BYTES')
    const file = ingestAsset(source, 'image.png', assetsDir(root), new AssetBudget())
    if (!file.ok) throw new Error('夹具摄取失败')
    expect(readAttachmentMedia(root, file.asset.assetId).toString()).toBe('SHARED_BYTES')
  })
  it('两目录出现同名不同物理对象时拒绝歧义，不默选另一会话资产', () => {
    const root = fixture()
    for (const dir of [assetsDir(root), attachmentsDir(root)]) mkdirSync(dir)
    const id = '20261014T120000-0-abc123.png'
    writeFileSync(join(assetsDir(root), id), 'NEW')
    writeFileSync(join(attachmentsDir(root), id), 'OLD')
    expect(() => readAsset(assetsDir(root), id)).toThrow(/冲突|歧义/)
  })
})

describe('统一容量不能被旧媒体保存旁路', () => {
  it('扫描中一项消失不能把剩余未知存量读成0，新添必须拒绝', () => {
    const root = fixture(); const dir = assetsDir(root); mkdirSync(dir)
    writeFileSync(join(dir, 'a-first'), 'one'); writeFileSync(join(dir, 'z-retained'), Buffer.alloc(1100))
    fault.missingOnStat = join(dir, 'a-first')
    const budget = assetBudgetForRoot(root, { maxTotalBytes: 1000 })
    expect(budget.reserve(1)).toBeNull()
    expect(readFileSync(join(dir, 'z-retained')).length).toBe(1100)
  })
  it('真实库根联接不能摄取/读取外部文件，解析权限异常也默认拒绝', () => {
    const root = fixture(); const external = fixture(); const dir = assetsDir(root)
    const id = '20261015T010000-0-aabbcc.txt'; writeFileSync(join(external, id), 'OUTSIDE_SENTINEL')
    symlinkSync(external, dir, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => readAsset(dir, id)).toThrow(/联接|越界/)
      const source = join(root, 'source.txt'); writeFileSync(source, 'NEW_BYTES')
      expect(ingestAsset(source, 'source.txt', dir, new AssetBudget()).ok).toBe(false)
      expect(readFileSync(join(external, id), 'utf8')).toBe('OUTSIDE_SENTINEL')
      expect(readdirSync(external)).toEqual([id])
    } finally { unlinkSync(dir) }
    mkdirSync(dir); writeFileSync(join(dir, id), 'INSIDE_SENTINEL')
    fault.deniedRealpath = dir
    expect(() => readAsset(dir, id)).toThrow()
    expect(assetBudgetForRoot(root).reserve(1)).toBeNull()
  })
  it('6MiB图片允许本地50MiB快照，但不能生成5MiB模型图片parts', async () => {
    const root = fixture()
    const data = join(root, 'data'); mkdirSync(data)
    writeFileSync(join(root, 'big.png'), Buffer.alloc(6 * 1024 * 1024))
    const attachment = await readAttachment(root, 'big.png', data, assetBudgetForRoot(data))
    expect(attachment.preview?.mime).toBe('image/png')
    expect(attachment.image).toBeUndefined()
    expect(attachment.bytes).toBe(6 * 1024 * 1024)
  })
  it('PPTX/未知二进制可留本地快照并明确降级，不把二进制正文发给模型', async () => {
    const root = fixture(); const data = join(root, 'data'); mkdirSync(data)
    for (const name of ['deck.pptx', 'unknown.binary']) {
      writeFileSync(join(root, name), Buffer.from('PK\u0000LOCAL_BINARY'))
      const got = await readAttachment(root, name, data, assetBudgetForRoot(data))
      expect(got.preview?.assetId).toBeTruthy()
      expect(got.content).toBe('')
      expect(got.image).toBeUndefined()
      expect(got.video).toBeUndefined()
    }
  })
  it('媒体宿主登记失败不能留下已提交占用或附件文件', () => {
    const root = fixture()
    const budget = new AssetBudget()
    const result = saveAttachmentImage(root, { mime: 'image/png', buf: Buffer.from('IMAGE_BYTES'), now: () => new Date(), budget,
      publish: () => { throw new Error('OWNER_WINDOW_CLOSED') } })
    expect(result).toBeNull()
    expect(budget.usedBytes).toBe(0)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(attachmentsDir(root))).toHaveLength(0)
  })
  it('rename失败时不能删掉失败目标处的外部新文件', () => {
    const root = fixture()
    const budget = new AssetBudget()
    fault.enabled = true
    const saved = saveAttachmentImage(root, { mime: 'image/png', buf: Buffer.from('OWNED_BYTES'), now: () => new Date(), budget })
    expect(saved).toBeNull()
    expect(readFileSync(fault.externalPath, 'utf8')).toBe('EXTERNAL_FILE_SENTINEL')
    expect(budget.usedBytes).toBe(0)
  })
  it('已占998字节、总量1000，新媒体5字节实拒，无新文件和在途占用', () => {
    const root = fixture()
    const budget = new AssetBudget({ maxTotalBytes: 1000 })
    budget.addCommitted(998)
    const saved = saveAttachmentImage(root, { mime: 'image/png', buf: Buffer.alloc(5), now: () => new Date(), budget })
    expect(saved).toBeNull()
    expect(budget.usedBytes).toBe(998)
    expect(budget.pendingReservations).toBe(0)
  })
  it('启动合计assets与attachments未知存量，重复取单例不双计，不删超额历史', () => {
    const root = fixture()
    mkdirSync(assetsDir(root)); mkdirSync(attachmentsDir(root))
    writeFileSync(join(assetsDir(root), 'unknown-old-file'), Buffer.alloc(700))
    writeFileSync(join(attachmentsDir(root), 'unknown-media'), Buffer.alloc(400))
    const budget = assetBudgetForRoot(root, { maxTotalBytes: 1000 })
    expect(budget.usedBytes).toBe(1100)
    expect(assetBudgetForRoot(root)).toBe(budget)
    expect(budget.usedBytes).toBe(1100)
    expect(budget.reserve(1)).toBeNull()
    expect(readAttachmentMedia).toBeTypeOf('function')
  })
})
