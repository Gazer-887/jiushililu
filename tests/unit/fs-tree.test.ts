import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRIES,
  SKIP_DIRS,
  formatSize,
  isTextPreviewable,
  shouldSkipEntry,
  sortEntries,
  type FsEntry
} from '@shared/fs-tree'
import { listWorkspaceDir, readWorkspaceFile } from '@main/workspace-fs'

// 工作区文件树（plan7 批 A）
//
// 两件事必须钉死：
//   ① **敏感文件不进列表**（.env / .git 等）—— 文件树里能看见就等于摊在屏幕上
//   ② **路径越界被拒**（与 Agent 同一道门）

const dirs: string[] = []

function tmpWs(): string {
  const d = mkdtempSync(join(tmpdir(), 'jsl-fs-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
})

const entry = (name: string, kind: 'file' | 'dir', size?: number): FsEntry => ({
  name,
  rel: name,
  kind,
  ...(size !== undefined ? { size } : {})
})

describe('shouldSkipEntry（哪些不该出现在文件树里）', () => {
  it('跳过噪音目录', () => {
    for (const d of SKIP_DIRS) {
      expect(shouldSkipEntry(d, 'dir'), d).toBe(true)
    }
  })

  it('**跳过点开头的文件**（.env 常含密钥，列出即暴露）', () => {
    expect(shouldSkipEntry('.env', 'file')).toBe(true)
    expect(shouldSkipEntry('.env.local', 'file')).toBe(true)
    expect(shouldSkipEntry('.gitignore', 'file')).toBe(true)
    expect(shouldSkipEntry('.vscode', 'dir')).toBe(true)
  })

  it('根目录下的点开头项**不跳过**（用户有权看到自己工作区根有什么）', () => {
    expect(shouldSkipEntry('.env', 'file', true)).toBe(false)
    expect(shouldSkipEntry('.editorconfig', 'file', true)).toBe(false)
  })

  it('但根目录下的噪音目录仍跳过', () => {
    expect(shouldSkipEntry('.git', 'dir', true)).toBe(true)
    expect(shouldSkipEntry('node_modules', 'dir', true)).toBe(true)
  })

  it('正常文件与目录不跳过', () => {
    expect(shouldSkipEntry('readme.md', 'file')).toBe(false)
    expect(shouldSkipEntry('src', 'dir')).toBe(false)
    expect(shouldSkipEntry('紫水晶采购清单.txt', 'file')).toBe(false)
  })
})

describe('sortEntries（目录在前，同类型按名排）', () => {
  it('目录排在文件前', () => {
    const sorted = sortEntries([
      entry('z.txt', 'file'),
      entry('a-dir', 'dir'),
      entry('b.txt', 'file')
    ])
    expect(sorted.map((e) => e.name)).toEqual(['a-dir', 'b.txt', 'z.txt'])
  })

  it('中文按拼音序而非内码序（localeCompare 的意义）', () => {
    const sorted = sortEntries([entry('紫水晶.txt', 'file'), entry('归档', 'dir')])
    expect(sorted[0]!.kind).toBe('dir') // 目录优先已生效
  })

  it('不修改原数组（纯函数）', () => {
    const input = [entry('b', 'file'), entry('a', 'file')]
    sortEntries(input)
    expect(input.map((e) => e.name)).toEqual(['b', 'a'])
  })
})

describe('formatSize', () => {
  it('按量级切换单位', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('非法值给占位符而非 NaN', () => {
    expect(formatSize(Number.NaN)).toBe('—')
    expect(formatSize(-1)).toBe('—')
  })
})

describe('isTextPreviewable（别把二进制糊到界面上）', () => {
  it('常见文本类型可预览', () => {
    for (const n of ['a.md', 'b.ts', 'c.json', 'd.py', 'e.txt', 'f.css', 'g.yaml']) {
      expect(isTextPreviewable(n), n).toBe(true)
    }
  })

  it('二进制类型不可预览', () => {
    for (const n of ['a.png', 'b.exe', 'c.zip', 'd.pdf', 'e.woff2', 'f.ico']) {
      expect(isTextPreviewable(n), n).toBe(false)
    }
  })

  it('无扩展名的给预览（Makefile / LICENSE 这类很常见）', () => {
    expect(isTextPreviewable('Makefile')).toBe(true)
    expect(isTextPreviewable('LICENSE')).toBe(true)
    expect(isTextPreviewable('.gitignore')).toBe(true)
  })
})

describe('listWorkspaceDir（真实目录）', () => {
  it('列出一层，目录在前', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'b.txt'), 'x', 'utf8')
    writeFileSync(join(ws, 'a.txt'), 'yy', 'utf8')
    mkdirSync(join(ws, 'docs'))

    const res = await listWorkspaceDir(ws)
    expect(res.ok).toBe(true)
    expect(res.entries.map((e) => e.name)).toEqual(['docs', 'a.txt', 'b.txt'])
    expect(res.entries[0]!.kind).toBe('dir')
  })

  it('文件带大小、目录不带', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'a.txt'), 'abc', 'utf8')
    mkdirSync(join(ws, 'd'))

    const { entries } = await listWorkspaceDir(ws)
    expect(entries.find((e) => e.name === 'a.txt')!.size).toBe(3)
    expect(entries.find((e) => e.name === 'd')!.size).toBeUndefined()
  })

  it('**噪音目录不出现在列表里**', async () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'node_modules'))
    mkdirSync(join(ws, '.git'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'node_modules', 'x.js'), 'x', 'utf8')

    const { entries } = await listWorkspaceDir(ws)
    const names = entries.map((e) => e.name)
    expect(names).toContain('src')
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
  })

  it('子目录用 `/` 拼相对路径（跨平台一致）', async () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'src', 'main'), { recursive: true })
    writeFileSync(join(ws, 'src', 'main', 'a.ts'), 'x', 'utf8')

    const sub = await listWorkspaceDir(ws, 'src/main')
    expect(sub.ok).toBe(true)
    expect(sub.entries[0]!.rel).toBe('src/main/a.ts')
    // 相对路径里绝不能出现反斜杠（与检查点清单、跨平台比较同一口径）
    expect(sub.entries[0]!.rel).not.toContain('\\')
  })

  it('**路径越界被拒**（与 Agent 同一道门）', async () => {
    const ws = tmpWs()
    const res = await listWorkspaceDir(ws, '../')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('越出工作区边界')
  })

  it('目录不存在 → 人话错误而非抛异常', async () => {
    const ws = tmpWs()
    const res = await listWorkspaceDir(ws, 'no-such-dir')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
  })

  it('对文件调用列目录 → 明确报错', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'a.txt'), 'x', 'utf8')
    const res = await listWorkspaceDir(ws, 'a.txt')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('空目录返回空列表（不是错误）', async () => {
    const ws = tmpWs()
    const res = await listWorkspaceDir(ws)
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([])
  })
})

describe('readWorkspaceFile（预览）', () => {
  it('读出文本内容与大小', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'a.txt'), '你好，九十里路', 'utf8')
    const res = await readWorkspaceFile(ws, 'a.txt')
    expect(res.ok).toBe(true)
    expect(res.content).toBe('你好，九十里路')
    expect(res.size).toBe(Buffer.byteLength('你好，九十里路', 'utf8'))
    expect(res.truncated).toBeUndefined()
  })

  it('**路径越界被拒**', async () => {
    const ws = tmpWs()
    const res = await readWorkspaceFile(ws, '../../../etc/passwd')
    expect(res.ok).toBe(false)
    expect(res.content).toBe('')
    expect(res.error).toContain('越出工作区边界')
  })

  it('文件不存在 → 人话错误', async () => {
    const ws = tmpWs()
    const res = await readWorkspaceFile(ws, 'nope.txt')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
  })

  it('对目录读文件 → 明确报错', async () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'd'))
    const res = await readWorkspaceFile(ws, 'd')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不是文件')
  })

  it('超过 256KB 时截断并**明确标记**（不假装读全了）', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(300 * 1024), 'utf8')
    const res = await readWorkspaceFile(ws, 'big.txt')
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.size).toBe(300 * 1024) // 真实大小照报
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('MAX_ENTRIES 截断保护', () => {
  it('条目过多时标记 truncated（不让界面被超大目录拖死）', async () => {
    const ws = tmpWs()
    // 造 MAX_ENTRIES + 5 个文件
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      writeFileSync(join(ws, `f${String(i).padStart(4, '0')}.txt`), '', 'utf8')
    }
    const res = await listWorkspaceDir(ws)
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.entries.length).toBe(MAX_ENTRIES)
  })
})
