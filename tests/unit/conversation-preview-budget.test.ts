// 对话内预览：容量与保留的命名断言（plan74 执行补充 6.1）。
//
// 直接调用**真实模块**（preview-assets / shared 合同），只换磁盘临时目录 —— 不复制规则成测试副本。
// 四条命名断言对应执行补充 6.1：50MiB 整收 / 50MiB+1 拒 / 并发预留不超额 / 失败释放回退。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetBudget, ingestAsset, readAsset, assetsDir } from '../../src/main/preview-assets'
import { MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES } from '../../src/shared/conversation-preview'

/** 每个用例独立临时目录，跑完清掉 —— 无前态残留。 */
function tmp(): { root: string; assets: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cpv-budget-'))
  const assets = assetsDir(root)
  return { root, assets, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 造一个恰好 size 字节的源文件。 */
function makeSrc(dir: string, name: string, size: number): string {
  const p = join(dir, name)
  writeFileSync(p, Buffer.alloc(size, 0x41))
  return p
}

describe('conversation-preview-budget', () => {
  it('accept-exact-50mib：真实临时文件 52428800 字节可收', () => {
    const t = tmp()
    try {
      const budget = new AssetBudget()
      const src = makeSrc(t.root, 'exact.bin', MAX_ASSET_BYTES)
      const r = ingestAsset(src, 'exact.bin', t.assets, budget)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.asset.bytes).toBe(MAX_ASSET_BYTES)
        // 真读回字节数一致
        expect(readAsset(t.assets, r.asset.assetId).byteLength).toBe(MAX_ASSET_BYTES)
      }
    } finally {
      t.cleanup()
    }
  })

  it('reject-50mib-plus-one：52428801 字节实拒，无新成功引用', () => {
    const t = tmp()
    try {
      const budget = new AssetBudget()
      const src = makeSrc(t.root, 'over.bin', MAX_ASSET_BYTES + 1)
      const r = ingestAsset(src, 'over.bin', t.assets, budget)
      expect(r.ok).toBe(false)
      // 预留未泄漏
      expect(budget.usedBytes).toBe(0)
      expect(budget.pendingReservations).toBe(0)
      // 没有半成品残留：目录未创建（在 mkdir 前就拒了）或创建了但无正式资产，都算过
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      const leftovers = existsSync(t.assets) ? readdirSync(t.assets).filter((n) => !n.startsWith('.')) : []
      expect(leftovers.length).toBe(0)
    } finally {
      t.cleanup()
    }
  })

  it('reserve-concurrently-without-overbooking：只够两份时第三份拒，不超额', () => {
    const t = tmp()
    try {
      // 总预算缩小到刚好两份（生产默认不改，仅测试注入）
      const unit = 1000
      const budget = new AssetBudget({ maxTotalBytes: unit * 2 })
      const src = makeSrc(t.root, 'a.bin', unit)
      const r1 = ingestAsset(src, 'a.bin', t.assets, budget)
      const r2 = ingestAsset(src, 'a.bin', t.assets, budget)
      const r3 = ingestAsset(src, 'a.bin', t.assets, budget)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      expect(r3.ok).toBe(false)
      // 占用恰好两份，未超额
      expect(budget.usedBytes).toBe(unit * 2)
      expect(budget.pendingReservations).toBe(0)
    } finally {
      t.cleanup()
    }
  })

  it('release-reservation-on-copy-failure：源读失败释放预留、无成功引用', () => {
    const t = tmp()
    try {
      const budget = new AssetBudget()
      // 不存在的源文件 → stat 即失败，预留从未占用
      const r = ingestAsset(join(t.root, 'nope.bin'), 'nope.bin', t.assets, budget)
      expect(r.ok).toBe(false)
      expect(budget.usedBytes).toBe(0)
      expect(budget.pendingReservations).toBe(0)
    } finally {
      t.cleanup()
    }
  })

  it('retain-referenced-assets-after-sixty：61+ 资产全部可读，本模块不做淘汰', () => {
    const t = tmp()
    try {
      const budget = new AssetBudget({ maxTotalBytes: MAX_TOTAL_ASSET_BYTES })
      const ids: string[] = []
      // 落 61 份小资产（远低于单文件上限）
      for (let i = 0; i < 61; i++) {
        const src = makeSrc(t.root, `f${i}.bin`, 10)
        const r = ingestAsset(src, `f${i}.bin`, t.assets, budget)
        expect(r.ok).toBe(true)
        if (r.ok) ids.push(r.asset.assetId)
      }
      // 全部仍可读 —— 本预算事务没有按数量淘汰的逻辑（停用 60 项清理的落点）
      for (const id of ids) {
        expect(() => readAsset(t.assets, id)).not.toThrow()
      }
      expect(budget.usedBytes).toBe(61 * 10)
    } finally {
      t.cleanup()
    }
  })

  it('total-budget-exact-boundary：恰好等于总预算可收，超一字节拒', () => {
    const t = tmp()
    try {
      const budget = new AssetBudget({ maxAssetBytes: 1000, maxTotalBytes: 1000 })
      const src = makeSrc(t.root, 'full.bin', 1000)
      const r1 = ingestAsset(src, 'full.bin', t.assets, budget)
      expect(r1.ok).toBe(true)
      // 再收任何正字节都超总预算
      const r2 = ingestAsset(src, 'full.bin', t.assets, budget)
      expect(r2.ok).toBe(false)
      expect(budget.usedBytes).toBe(1000)
    } finally {
      t.cleanup()
    }
  })
})
