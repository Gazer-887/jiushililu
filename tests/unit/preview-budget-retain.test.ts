// 资产预算与保留的命名断言（plan74 第四组，对应 Spec R4 反例 5/6/7）。
// 直接 import 真实 AssetBudget + ingestAsset + attachments-store，喂真实临时文件 —— 不用假数据。
// 先红后绿：修前第61项删第1项、rename 失败不释放、复制增长破总预算（审查端反例实测坐实）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetBudget, ingestAsset } from '../../src/main/preview-assets'
import { saveAttachmentMedia, attachmentsDir } from '../../src/main/attachments-store'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pv-r4-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AssetBudget：复制增长重新核总预算（R4 反例7）', () => {
  it('commit 后超总预算 → 返回 false 且增长部分回退（修前静默成功、usedBytes 超限）', () => {
    const budget = new AssetBudget({ maxAssetBytes: 5000, maxTotalBytes: 1000 })
    // 已占用 100
    const existing = budget.reserve(100)!
    expect(existing).toBeTruthy()
    budget.commit(existing, 100)
    // 源预留 800，复制中长到 1000 → 100 + 1000 = 1100 > 1000
    const reserved = budget.reserve(800)!
    expect(reserved).toBeTruthy()
    const ok = budget.commit(reserved, 1000)
    expect(ok).toBe(false)
    // 增长部分（200）已回退，预留的 800 仍在（占用 900，未突破 1000 上限的假象）
    expect(budget.usedBytes).toBe(900)
    // 调用方走失败收尾释放预留后，占用回到 100
    budget.release(reserved)
    expect(budget.usedBytes).toBe(100)
    expect(budget.pendingReservations).toBe(0)
  })

  it('commit 后在总预算内 → 正常计入', () => {
    const budget = new AssetBudget({ maxAssetBytes: 5000, maxTotalBytes: 2000 })
    const reserved = budget.reserve(800)!
    expect(budget.commit(reserved, 800)).toBe(true)
    expect(budget.usedBytes).toBe(800)
  })
})

describe('ingestAsset：摄取成功路径（rename 成功、登记、预算计入）', () => {
  // ⚠️ 本块名原为「rename 失败走事务收尾」，但断言跑的是**成功**路径——块名承诺了它没测的东西。
  // rename 失败的真实故障覆盖在 `preview-ingest-transaction.test.ts`（renameSync 故障注入）
  // 与 `preview-shared-storage.test.ts`（rename 落到外部文件时不删别人的新文件）；本块不重复它。
  it('正常摄取（rename 成功）→ 释放预留、登记、预算计入，不冒称失败收尾', () => {
    const budget = new AssetBudget({ maxAssetBytes: 5000, maxTotalBytes: 100000 })
    // 造一个源文件
    const src = join(root, 'src-rename.txt')
    writeFileSync(src, 'hello')
    // 这里验证：摄取成功路径正常（rename 成功、登记、预算计入）；rename 失败的收尾见上方注释指向的真实覆盖点。
    const res = ingestAsset(src, 'ok.txt', join(root, 'assets1'), budget)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(budget.usedBytes).toBe(res.asset.bytes)
      expect(budget.pendingReservations).toBe(0)
    }
  })
})

describe('历史不淘汰：旧媒体第61项不删第1项（R4 反例5）', () => {
  it('生产默认50MiB+1实际文件在复制前拒绝；默认1GiB并发预留不超额', () => {
    const source = join(root, 'actual-50m-plus-one.bin')
    writeFileSync(source, Buffer.alloc(50 * 1024 * 1024 + 1))
    const budget = new AssetBudget()
    const result = ingestAsset(source, 'large.bin', join(root, 'default-limit-assets'), budget)
    expect(result.ok).toBe(false)
    expect(budget.usedBytes).toBe(0)
    expect(budget.pendingReservations).toBe(0)
    budget.addCommitted(1024 * 1024 * 1024 - 50 * 1024 * 1024)
    const pending = budget.reserve(30 * 1024 * 1024)
    expect(pending).toBeTruthy()
    expect(budget.reserve(25 * 1024 * 1024)).toBeNull()
    budget.release(pending!)
    expect(budget.reserve(50 * 1024 * 1024)).toBeTruthy()
    expect(budget.usedBytes).toBe(1024 * 1024 * 1024)
  })
  it('连续存 61 份媒体附件，第 1 项仍存在（修前被 prune 删掉）', () => {
    const attachRoot = join(root, 'attach61')
    let firstRef = ''
    for (let i = 0; i < 61; i++) {
      const ref = saveAttachmentMedia(attachRoot, {
        mime: 'image/png',
        buf: Buffer.from(`img-${i}`),
        index: i,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        maxBytes: 1024 * 1024
      })
      expect(ref).not.toBeNull()
      if (i === 0 && ref) firstRef = ref.ref
    }
    // 第 1 项的引用文件必须还在
    const files = readdirSync(attachmentsDir(attachRoot))
    expect(files).toContain(firstRef)
    expect(files.length).toBe(61)
  })
})
