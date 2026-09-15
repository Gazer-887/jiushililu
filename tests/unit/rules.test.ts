import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeRulesBlock } from '@main/rules/rules'

// 规则系统单测（plan24 S4）。判据编号对应 plan24 §验收。
// composeRulesBlock 是纯函数（fs 只读工作区/用户目录），架构守卫随 TEST_ENTRIES 覆盖。

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'jsll-rules-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('composeRulesBlock（plan24）', () => {
  it('无任何规则文件 → null（判据 4）', () => {
    const ws = tmp()
    const ud = tmp()
    expect(composeRulesBlock(ws, ud).block).toBeNull()
  })

  it('工作区 AGENTS.md → 注入并标注来源（判据 1）', () => {
    const ws = tmp()
    const ud = tmp()
    writeFileSync(join(ws, 'AGENTS.md'), '# 项目约定\n永远用 TypeScript。', 'utf8')
    const r = composeRulesBlock(ws, ud)
    expect(r.block).toContain('[规则 工作区/AGENTS.md]')
    expect(r.block).toContain('永远用 TypeScript')
  })

  it('rules/ 目录多文件按文件名排序注入', () => {
    const ws = tmp()
    writeFileSync(join(ws, 'AGENTS.md'), '主约定', 'utf8')
    mkdirSync(join(ws, 'rules'))
    writeFileSync(join(ws, 'rules', 'b.md'), '规则 B', 'utf8')
    writeFileSync(join(ws, 'rules', 'a.md'), '规则 A', 'utf8')
    const r = composeRulesBlock(ws, null)
    const labels = (r.block ?? '').match(/\[规则 [^\]]+\]/g) ?? []
    expect(labels).toEqual(['[规则 工作区/AGENTS.md]', '[规则 工作区/rules/a.md]', '[规则 工作区/rules/b.md]'])
  })

  it('预算 8KB：超限按文件丢、块尾列文件名、成品 ≤ 8KB（判据 3）', () => {
    const ws = tmp()
    writeFileSync(join(ws, 'AGENTS.md'), '主约定', 'utf8')
    mkdirSync(join(ws, 'rules'))
    for (let i = 0; i < 12; i++) {
      // 每个规则文件 ≈ 1KB（utf8），12 个必超 8KB
      writeFileSync(join(ws, 'rules', `r${i}.md`), `规则${i}：${'条'.repeat(300)}`, 'utf8')
    }
    const r = composeRulesBlock(ws, null)
    expect(r.droppedFiles.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(r.block ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(r.block ?? '').toContain('未注入')
    expect(r.block ?? '').toContain('工作区/AGENTS.md') // 被丢的文件名要列出
  })

  it('工作区与用户层并存：工作区条目在前（预算截断时先保工作区）', () => {
    const ws = tmp()
    const ud = tmp()
    writeFileSync(join(ws, 'AGENTS.md'), '工作区规则', 'utf8')
    mkdirSync(join(ud, 'rules'))
    writeFileSync(join(ud, 'rules', 'personal.md'), '个人规则', 'utf8')
    const r = composeRulesBlock(ws, ud)
    const labels = (r.block ?? '').match(/\[规则 [^\]]+\]/g) ?? []
    expect(labels[0]).toBe('[规则 工作区/AGENTS.md]')
    expect(labels[1]).toBe('[规则 用户/rules/personal.md]')
  })
})
