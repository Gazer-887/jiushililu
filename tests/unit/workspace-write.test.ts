import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspaceWriter } from '@main/workspace-write'

// 统一写入服务（plan7 批 A2）：界面与 Agent 共用同一条写入路径。
// 三条不能破的规矩：越界一律拒且不留快照、快照必须发生在真正落盘**之前**、删除走**回收站**不硬删。

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-write-'))
  const trashed: string[] = []
  const snaps: string[] = []
  const writer = createWorkspaceWriter(root, {
    beforeChange: (rel, abs) => snaps.push(`${rel}|${existsSync(abs) ? 'exists' : 'missing'}`),
    trash: async (abs) => {
      trashed.push(abs)
    }
  })
  return { root, writer, trashed, snaps }
}

describe('workspace-write（统一写入服务）', () => {
  it('write 落盘并可读回', async () => {
    const { root, writer } = setup()
    const msg = await writer.write('a/b.txt', '你好')
    expect(msg).toContain('已写入')
    expect(readFileSync(join(root, 'a', 'b.txt'), 'utf8')).toBe('你好')
  })

  it('write 自动建父目录（调用方不该为 mkdir 单独跑一趟）', async () => {
    const { root, writer } = setup()
    await writer.write('deep/nest/x.txt', 'x')
    expect(existsSync(join(root, 'deep', 'nest', 'x.txt'))).toBe(true)
  })

  it('快照发生在**落盘之前**（覆盖已有文件时看到的是旧内容）', async () => {
    const { root, writer, snaps } = setup()
    writeFileSync(join(root, 'old.txt'), '原始', 'utf8')
    await writer.write('old.txt', '新的')
    expect(snaps).toEqual(['old.txt|exists'])
    expect(readFileSync(join(root, 'old.txt'), 'utf8')).toBe('新的')
  })

  it('越界写入被拒绝，且**不留快照**（拒绝的操作不该污染回滚记录）', async () => {
    const { writer, snaps } = setup()
    await expect(writer.write('../evil.txt', 'x')).rejects.toThrow('越出工作区边界')
    expect(snaps).toHaveLength(0)
  })

  it('mkdir 建目录（含多级）', async () => {
    const { root, writer } = setup()
    await writer.mkdir('newdir/sub')
    expect(existsSync(join(root, 'newdir', 'sub'))).toBe(true)
  })

  it('rename：源消失、目标出现，且**两边都留快照**', async () => {
    // 为什么两边都要：源要写回、目标要删除 —— 缺一条都退不回 rename 之前
    const { root, writer, snaps } = setup()
    writeFileSync(join(root, 'from.txt'), '内容', 'utf8')
    await writer.rename('from.txt', 'to.txt')
    expect(existsSync(join(root, 'from.txt'))).toBe(false)
    expect(readFileSync(join(root, 'to.txt'), 'utf8')).toBe('内容')
    expect(snaps).toEqual(['from.txt|exists', 'to.txt|missing'])
  })

  it('remove 走回收站，**不硬删**', async () => {
    const { root, writer, trashed } = setup()
    writeFileSync(join(root, 'del.txt'), 'x', 'utf8')
    const msg = await writer.remove('del.txt')
    expect(trashed).toEqual([join(root, 'del.txt')])
    expect(msg).toContain('回收站')
    // 假的 trash 不会真删，文件仍在 —— 正好证明服务本身没有硬删
    expect(existsSync(join(root, 'del.txt'))).toBe(true)
  })

  it('copyIn 把工作区外的文件复制进来（拖拽上传）', async () => {
    const { root, writer } = setup()
    const src = join(mkdtempSync(join(tmpdir(), 'jsl-src-')), 'in.txt')
    writeFileSync(src, '外部内容', 'utf8')
    await writer.copyIn(src, 'imported/in.txt')
    expect(readFileSync(join(root, 'imported', 'in.txt'), 'utf8')).toBe('外部内容')
  })

  it('copyIn 同名**不覆盖**，自动加序号（拖两次同一个文件很常见）', async () => {
    const { root, writer } = setup()
    const src = join(mkdtempSync(join(tmpdir(), 'jsl-src3-')), 'dup.txt')
    writeFileSync(src, '第一次', 'utf8')
    const first = await writer.copyIn(src, 'dup.txt')
    expect(first).toContain('已导入 dup.txt')
    // 改掉源文件内容再拖一次：原有文件绝不能被悄悄覆盖
    writeFileSync(src, '第二次', 'utf8')
    const second = await writer.copyIn(src, 'dup.txt')
    expect(second).toContain('另存为 dup (2).txt')
    expect(readFileSync(join(root, 'dup.txt'), 'utf8')).toBe('第一次')
    expect(readFileSync(join(root, 'dup (2).txt'), 'utf8')).toBe('第二次')
  })

  it('copyIn 拒绝目录（别把整棵树搬进来）', async () => {
    const { writer } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'jsl-srcdir-'))
    await expect(writer.copyIn(dir, 'x')).rejects.toThrow('只支持拖入文件')
  })

  it('copyIn 目标越界被拒绝', async () => {
    const { writer } = setup()
    const src = join(mkdtempSync(join(tmpdir(), 'jsl-src2-')), 'in.txt')
    writeFileSync(src, 'x', 'utf8')
    await expect(writer.copyIn(src, '../out.txt')).rejects.toThrow('越出工作区边界')
  })
})
