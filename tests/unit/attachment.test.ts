import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ATTACH_LIMIT, readAttachment } from '@main/workspace-fs'

// 附件读取（③ 文件拖进会话 / 文件选择框 **共用**这一份）
//
// 为什么值得单独测：两个入口只差"路径从哪来"，边界规则只在这里定义一次。
// 重点钉**两层边界的差别** —— 绝对路径（主人在系统里明确拖进来的）放行并标记，
// 相对路径（自家文件树给的）越界一律拒绝。这条线被放松过一次（2026-09-12 用户定案），
// 所以更要有测试把它钉住：**放松的是哪一层、哪一层不许动**，必须写死在断言里。

describe('readAttachment（路径 → 附件）', () => {
  let root = ''
  let outsideDir = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jsl-attach-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'jsl-outside-'))
    writeFileSync(join(root, 'a.txt'), 'hello 附件', 'utf8')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'nested', 'utf8')
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(ATTACH_LIMIT + 100), 'utf8')
    writeFileSync(join(outsideDir, 'secret.txt'), '工作区外的东西', 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('工作区相对路径 → 读成附件（文件树拖出来就是这条路）', async () => {
    const a = await readAttachment(root, 'a.txt')
    expect(a.name).toBe('a.txt')
    expect(a.content).toBe('hello 附件')
    expect(a.truncated).toBe(false)
    expect(a.path.startsWith(root)).toBe(true)
  })

  it('子目录里的相对路径也能读', async () => {
    const a = await readAttachment(root, 'sub/b.txt')
    expect(a.name).toBe('b.txt')
    expect(a.content).toBe('nested')
  })

  it('绝对路径也认 —— **只要在工作区内**（系统拖进来的就是这条路）', async () => {
    const a = await readAttachment(root, join(root, 'a.txt'))
    expect(a.content).toBe('hello 附件')
    // 在工作区内就不该带"外面"的标记
    expect(a.outside).toBeUndefined()
  })

  it('**工作区外的文件放行，但要标出来**（2026-09-12 用户定案）', async () => {
    // 依据：把一份文件拖进会话是**主人的显式动作** —— 和粘贴一段文字同级。
    // 拦下来保护不到任何东西，只会让人觉得"拖不进去"（旧版就是这么被报上来的）。
    const outside = join(outsideDir, 'secret.txt')
    const a = await readAttachment(root, outside)
    expect(a.content).toBe('工作区外的东西')
    expect(a.path).toBe(outside)
    expect(a.outside).toBe(true)
  })

  it('用 .. 往外跳仍被拒绝（相对路径这条线**不能松**，它只该来自自家文件树）', async () => {
    const err = (await readAttachment(root, '../secret.txt').catch((e) => e)) as Error
    expect(err.message).toContain('越出了工作区')
    // 被拒的**原始载荷**与**当时的边界**都要原样回显 —— 否则看不出到底是谁越界、边界在哪
    expect(err.message).toContain('../secret.txt')
    expect(err.message).toContain(root)
  })

  it('超过 64KB 截断并**标注**（不假装读全了）', async () => {
    const a = await readAttachment(root, 'big.txt')
    expect(a.truncated).toBe(true)
    expect(a.content.length).toBe(ATTACH_LIMIT)
  })

  it('读不了的文件，错误信息**带上是哪个文件**（不是一句"文件不存在"）', async () => {
    const missing = join(root, 'nope.txt')
    const err = (await readAttachment(root, 'nope.txt').catch((e) => e)) as Error
    expect(err.message).toContain(missing)
  })
})
