import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyExactEdits, createFileTools, type EditSpec } from '@main/agent/tools/file-tools'
import { createWorkspaceWriter } from '@main/workspace-write'
import type { AgentTool } from '@shared/agent'

// edit 工具（plan28 D-084）：精确字符串替换。
//
// 这组用例的重心**不是"改对了"，而是"没改错"** —— 一个会悄悄改错地方的编辑器比没有编辑器糟得多：
// 它写出的文件既不是旧的也不是新的，而模型会以为自己改成功了，继续在上面往下做。
// 所以每条失败路径都要断言**盘上文件一个字节都没变**，而不是只断言"返回了错误文本"。

const specs = (rows: Array<[string, string]>): EditSpec[] => rows.map(([oldText, newText]) => ({ oldText, newText }))

describe('applyExactEdits（纯逻辑）', () => {
  it('单处精确替换', () => {
    const r = applyExactEdits('const a = 1\nconst b = 2\n', specs([['const a = 1', 'const a = 42']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('const a = 42\nconst b = 2\n')
    expect(r.applied).toHaveLength(1)
    expect(r.applied[0]).toMatchObject({ index: 0, line: 1, matchedBy: 'exact' })
  })

  it('多处替换在一次调用内完成，按顺序应用', () => {
    const src = 'a\nb\nc\n'
    const r = applyExactEdits(src, specs([['a', 'A'], ['c', 'C']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('A\nb\nC\n')
    expect(r.applied.map((x) => x.index)).toEqual([0, 1])
    expect(r.applied.map((x) => x.line)).toEqual([1, 3])
  })

  it('后一处能匹配到「前一处刚写进去的内容」（顺序应用，不是并行各自对原文件）', () => {
    // 这条不是细节：若实现成"每处都对原始文本匹配"，下面这行就会失败。
    // 顺序语义让模型可以写「先改 A，再把 A 附近的东西改掉」，更强且更符合直觉。
    const r = applyExactEdits('one\n', specs([['one', 'two'], ['two', 'three']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('three\n')
  })

  it('找不到 → 拒绝，且不返回任何文本', () => {
    const r = applyExactEdits('hello\n', specs([['不存在的内容', 'x']]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.index).toBe(0)
    expect(r.reason).toContain('找不到')
  })

  it('**匹配到多处 → 拒绝**（改哪一个全凭猜，比不改更危险）', () => {
    const r = applyExactEdits('x\ny\nx\n', specs([['x', 'z']]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('2 处')
    expect(r.reason).toContain('唯一')
  })

  it('空 oldText → 拒绝（空串在哪儿都能匹配，是纯破坏性输入）', () => {
    const r = applyExactEdits('abc', specs([['', 'x']]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('oldText 为空')
  })

  it('edits 为空 → 拒绝（index = -1 表示不是"某一处"的问题）', () => {
    const r = applyExactEdits('abc', [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.index).toBe(-1)
  })

  it('**原子性**：第二处失配 → 整次失败，报出是第几处', () => {
    const r = applyExactEdits('a\nb\n', specs([['a', 'A'], ['没有这个', 'X']]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.index).toBe(1) // 第二处（0 起）
  })

  it('newText 为空串 = 删除这一段', () => {
    const r = applyExactEdits('keep\n删掉这行\nkeep2\n', specs([['删掉这行\n', '']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('keep\nkeep2\n')
  })

  it('deltaBytes 如实反映字节增减（负值也要给）', () => {
    const r = applyExactEdits('abc\n', specs([['abc', 'a']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.applied[0]?.deltaBytes).toBe(-2)
  })

  it('CRLF 文件 + LF 的 oldText → 归一化命中，且**写回用文件的 CRLF**（不混换行）', () => {
    const src = 'line1\r\nline2\r\n'
    const r = applyExactEdits(src, specs([['line1\nline2', 'LINE1\nLINE2']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.applied[0]?.matchedBy).toBe('normalized')
    expect(r.text).toBe('LINE1\r\nLINE2\r\n') // ← 只有 \r\n，没有混进裸 \n
  })

  it('LF 文件 + CRLF 的 newText → 写回用 LF', () => {
    const r = applyExactEdits('a\n', specs([['a', 'x\r\ny']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('x\ny\n')
  })

  it('归一化后仍多处命中 → 同样拒绝（归一化不能变成"放宽到随便改"）', () => {
    const src = 'x\r\nx\n'
    const r = applyExactEdits(src, specs([['x\ny', 'z']]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('处')
  })

  it('原文原样返回：新替换不引入换行时，文件里其他换行一个不动', () => {
    const src = 'a\r\nb\r\nc\r\n'
    const r = applyExactEdits(src, specs([['b', 'B']]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('a\r\nB\r\nc\r\n')
  })
})

// ── 工具层：真的落盘 ────────────────────────────────────────────────────────

function makeTool(): { tool: AgentTool; dir: string; snapshots: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-edit-'))
  const snapshots: string[] = []
  const writer = createWorkspaceWriter(dir, {
    beforeChange: (rel) => snapshots.push(rel),
    trash: async () => {}
  })
  const tool = createFileTools(writer).find((t) => t.schema.name === 'edit')!
  return {
    tool,
    dir,
    snapshots,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  }
}

describe('edit 工具（真落盘）', () => {
  it('替换成功 → 盘上内容变了，且**走了检查点快照**（与 write_file 同一条写入路径）', async () => {
    const t = makeTool()
    try {
      writeFileSync(join(t.dir, 'a.ts'), 'const x = 1\nconst y = 2\n', 'utf8')
      const out = await t.tool.execute({ path: 'a.ts', edits: specs([['const x = 1', 'const x = 100']]) })
      expect(out).toContain('已写入')
      expect(out).toContain('1 处替换')
      expect(readFileSync(join(t.dir, 'a.ts'), 'utf8')).toBe('const x = 100\nconst y = 2\n')
      expect(t.snapshots).toEqual(['a.ts']) // ← 写前快照，回滚才有得退
    } finally {
      t.cleanup()
    }
  })

  it('**失配 → 盘上文件一个字节都没变**（这是本工具最重要的属性）', async () => {
    const t = makeTool()
    try {
      const original = 'const x = 1\n'
      writeFileSync(join(t.dir, 'a.ts'), original, 'utf8')
      const out = await t.tool.execute({ path: 'a.ts', edits: specs([['const x = 999', 'const x = 1000']]) })
      expect(out).toContain('未做任何改动')
      expect(readFileSync(join(t.dir, 'a.ts'), 'utf8')).toBe(original)
      expect(t.snapshots).toEqual([]) // 连快照都不该记 —— 什么都没发生
    } finally {
      t.cleanup()
    }
  })

  it('**原子性**：多段里有一段失配 → 已经在前面成立的那些也一个都不落盘', async () => {
    const t = makeTool()
    try {
      const original = 'aaa\nbbb\n'
      writeFileSync(join(t.dir, 'a.ts'), original, 'utf8')
      const out = await t.tool.execute({ path: 'a.ts', edits: specs([['aaa', 'AAA'], ['找不到的', 'X']]) })
      expect(out).toContain('第 2 处')
      expect(readFileSync(join(t.dir, 'a.ts'), 'utf8')).toBe(original) // ← 第一个替换也没写进去
      expect(t.snapshots).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('替换文本与原文相同 → 不写入（不产生一条无意义的回滚记录）', async () => {
    const t = makeTool()
    try {
      writeFileSync(join(t.dir, 'a.ts'), 'same\n', 'utf8')
      const out = await t.tool.execute({ path: 'a.ts', edits: specs([['same', 'same']]) })
      expect(out).toContain('内容无变化')
      expect(t.snapshots).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('文件不存在 → 明确提示改用 write_file（不是含糊的"读取失败"）', async () => {
    const t = makeTool()
    try {
      const out = await t.tool.execute({ path: 'nope.ts', edits: specs([['a', 'b']]) })
      expect(out).toContain('不存在')
      expect(out).toContain('write_file')
    } finally {
      t.cleanup()
    }
  })

  it('越界路径 → 拒绝', async () => {
    const t = makeTool()
    try {
      const out = await t.tool.execute({ path: '../../evil.ts', edits: specs([['a', 'b']]) })
      expect(out).toContain('越出工作区边界')
    } finally {
      t.cleanup()
    }
  })

  it('二进制文件 → 拒绝（不是把替换做进乱码里）', async () => {
    const t = makeTool()
    try {
      writeFileSync(join(t.dir, 'a.bin'), Buffer.from([0x41, 0x00, 0x42]))
      const out = await t.tool.execute({ path: 'a.bin', edits: specs([['A', 'Z']]) })
      expect(out).toContain('二进制')
      expect(readFileSync(join(t.dir, 'a.bin'))[0]).toBe(0x41) // 原字节未动
    } finally {
      t.cleanup()
    }
  })

  it('edits 形状不对（不是数组）→ 人话报错，不抛异常', async () => {
    const t = makeTool()
    try {
      writeFileSync(join(t.dir, 'a.ts'), 'x\n', 'utf8')
      await expect(t.tool.execute({ path: 'a.ts', edits: 'nope' })).resolves.toContain('缺少 edits 参数')
    } finally {
      t.cleanup()
    }
  })

  it('工具确实在文件工具集里导出（工具装配漏了它 = 能力等于没做）', () => {
    const t = makeTool()
    try {
      const names = createFileTools(createWorkspaceWriter(t.dir, { trash: async () => {} })).map((x) => x.schema.name)
      expect(names).toContain('edit')
      expect(names).toContain('read_file')
      expect(names).toContain('write_file')
    } finally {
      t.cleanup()
    }
  })
})
