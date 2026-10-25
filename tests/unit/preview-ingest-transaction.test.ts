// 摄取事务的组合故障：只替换真实磁盘外设，预算与事务均使用产品实现。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetBudget, ingestAsset, storeAssetBuffer } from '../../src/main/preview-assets'

const fault = vi.hoisted(() => ({ source: '', growth: 0, rename: false, close: false, copy: false, collision: false, collisionPath: '' }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (fault.collision && args[1] === 'wx') {
        fault.collisionPath = String(args[0]); fs.writeFileSync(args[0], 'NOT_OWNED_TEMP')
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      }
      return fs.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.collision && String(args[0]).includes('.ingest-')) {
        fault.collisionPath = String(args[0]); fs.writeFileSync(args[0], 'NOT_OWNED_TEMP')
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      }
      return fs.writeFileSync(...args)
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      if (fault.growth) {
        fs.appendFileSync(fault.source, Buffer.alloc(fault.growth))
        fault.growth = 0
      }
      if (fault.copy) throw new Error('OWNED_COPY_FAILURE')
      return fs.readSync(...args)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.rename) throw new Error('OWNED_RENAME_FAILURE')
      return fs.renameSync(...args)
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      if (fault.close) {
        fault.close = false
        throw new Error('OWNED_CLOSE_FAILURE')
      }
    }
  }
})

const roots: string[] = []
afterEach(() => {
  Object.assign(fault, { source: '', growth: 0, rename: false, close: false, copy: false, collision: false, collisionPath: '' })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-ingest-transaction-'))
  roots.push(root)
  const source = join(root, 'source.bin')
  writeFileSync(source, Buffer.alloc(800))
  const assets = join(root, 'assets')
  const budget = new AssetBudget({ maxAssetBytes: 2000, maxTotalBytes: 3000 })
  budget.addCommitted(100)
  fault.source = source
  return { source, assets, budget }
}

describe('摄取全过程只结算一次', () => {
  it.each(['file', 'buffer'])('%s排他创建失败不能删除原本不属于本次的临时文件', kind => {
    const { source, assets, budget } = fixture()
    fault.collision = true
    const result = kind === 'file' ? ingestAsset(source, 'source.bin', assets, budget) : storeAssetBuffer(Buffer.from('NEW_BYTES'), 'new.bin', assets, budget)
    expect(result.ok).toBe(false)
    expect(readFileSync(fault.collisionPath, 'utf8')).toBe('NOT_OWNED_TEMP')
    expect(budget.pendingReservations).toBe(0)
  })
  it('复制增长后宿主登记抛错：没有正式文件、草稿成功引用或残余占用', () => {
    const { source, assets, budget } = fixture()
    fault.growth = 100
    const result = ingestAsset(source, 'source.bin', assets, budget, () => { throw new Error('WINDOW_DESTROYED_BEFORE_PUBLICATION') })
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toHaveLength(0)
  })
  it('结算拒绝时撤销已经写入的宿主登记，只回收本次文件', () => {
    const { source, assets, budget } = fixture()
    const live = new Set<string>()
    vi.spyOn(budget, 'commit').mockReturnValue(false)
    const result = ingestAsset(source, 'source.bin', assets, budget, asset => {
      live.add(asset.assetId)
      return () => { live.delete(asset.assetId) }
    })
    expect(result.ok).toBe(false)
    expect(live.size).toBe(0)
    expect(budget.usedBytes).toBe(100)
    expect(readdirSync(assets)).toHaveLength(0)
  })
  it('源增长但仍在预算内，随后rename失败：回到原100字节，不残留200字节', () => {
    const { source, assets, budget } = fixture()
    fault.growth = 200
    fault.rename = true
    const result = ingestAsset(source, 'source.bin', assets, budget)
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toEqual([])
  })

  it('关闭源描述符报错：关闭另一个描述符并释放占用，不抛出未收尾异常', () => {
    const { source, assets, budget } = fixture()
    fault.close = true
    const result = ingestAsset(source, 'source.bin', assets, budget)
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toEqual([])
  })

  it('复制失败：先关闭句柄再清半成品，保留既有占用', () => {
    const { source, assets, budget } = fixture()
    fault.copy = true
    const result = ingestAsset(source, 'source.bin', assets, budget)
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toEqual([])
  })

  it('源增长成功：按实际1000字节结算，既有100字节不变', () => {
    const { source, assets, budget } = fixture()
    fault.growth = 200
    const result = ingestAsset(source, 'source.bin', assets, budget)
    expect(result.ok).toBe(true)
    expect(budget.usedBytes).toBe(1100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toHaveLength(1)
  })

  it('源增长超过总预算：拒绝且不登记文件', () => {
    const { source, assets } = fixture()
    const budget = new AssetBudget({ maxAssetBytes: 2000, maxTotalBytes: 1000 })
    budget.addCommitted(100)
    fault.growth = 200
    const result = ingestAsset(source, 'source.bin', assets, budget)
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
    expect(readdirSync(assets)).toEqual([])
  })

  it('空文件有合法不可变副本：不把0字节等同于预算不足', () => {
    const { source, assets, budget } = fixture()
    writeFileSync(source, '')
    const result = ingestAsset(source, 'empty.txt', assets, budget)
    expect(result.ok).toBe(true)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
  })
})

describe('预算拒绝非字节数字', () => {
  it.each([NaN, Infinity, -1, 0.5])('非法预留 %s 不污染账', (bytes) => {
    const budget = new AssetBudget()
    expect(budget.reserve(bytes)).toBeFalsy()
    expect(budget.usedBytes).toBe(0)
    expect(budget.pendingReservations).toBe(0)
  })

  it('同一预留重复释放不扣其他请求，其他账本不能释放本账本预留', () => {
    const budget = new AssetBudget({ maxTotalBytes: 1000 })
    const other = new AssetBudget({ maxTotalBytes: 1000 })
    const a = budget.reserve(100)
    const b = budget.reserve(200)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    if (!a || !b) throw new Error('夹具预留失败')
    other.release(b)
    expect(budget.usedBytes).toBe(300)
    budget.release(a)
    budget.release(a)
    expect(budget.usedBytes).toBe(200)
    expect(budget.pendingReservations).toBe(1)
    expect(budget.commit(b, 200)).toBe(true)
    budget.release(b)
    expect(budget.usedBytes).toBe(200)
    expect(budget.pendingReservations).toBe(0)
  })
})
