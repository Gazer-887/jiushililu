import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ATTACH_LIMIT, readAttachment } from '@main/workspace-fs'

// 附件读取（③ 文件拖进会话 / 文件选择框 **共用**这一份）
//
// 为什么值得单独测：两个入口只差"路径从哪来"，而**从系统资源管理器拖一个文件进来**
// 是最容易绕过工作区边界的路径 —— 文件选择框有 defaultPath 引导，拖拽没有。
// 所以这里重点钉"越界一律拒绝"，而不是只测顺的那条。

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
  })

  it('**工作区外的文件被拒绝**（拖拽最容易踩的这条）', async () => {
    await expect(readAttachment(root, join(outsideDir, 'secret.txt'))).rejects.toThrow(/越界/)
  })

  it('用 .. 往外跳也被拒绝（不能让相对路径绕过边界）', async () => {
    await expect(readAttachment(root, '../secret.txt')).rejects.toThrow(/越界/)
  })

  it('超过 64KB 截断并**标注**（不假装读全了）', async () => {
    const a = await readAttachment(root, 'big.txt')
    expect(a.truncated).toBe(true)
    expect(a.content.length).toBe(ATTACH_LIMIT)
  })

  it('文件不存在时抛错（错误信息是人话，直接给用户看）', async () => {
    await expect(readAttachment(root, 'nope.txt')).rejects.toThrow()
  })
})
