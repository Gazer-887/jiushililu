// MCP 图片产物（plan44 S2b）：落盘、白名单、按 mtime 清、读取侧的穿越面。
// 用**真临时目录**（`mkdtempSync`）—— 这一片要验的就是"文件真的在盘上、名字真的被拦"，
// 假 fs 会把"越界名被拒"这类判据演化成"根本没走到判断"（假后端少实现一处，产品就没被验到）。

import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_MCP_ARTIFACTS,
  mcpArtifactDir,
  mcpArtifactName,
  pruneMcpArtifacts,
  readMcpImageDataUrl,
  saveMcpImage
} from '@main/mcp/artifacts'
import { MAX_IMAGE_BYTES } from '@shared/fs-tree'

const FIXED = new Date('2026-09-24T02:20:33.000Z')
/** 1x1 的合法 PNG（base64），只用来占位 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jsl-art-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('存图：收哪些、拒哪些', () => {
  it('png 落进 mcp-artifacts/，引用带名字/类型/字节数', () => {
    const ref = saveMcpImage(root, { mime: 'image/png', base64: PNG, index: 0, now: () => FIXED })
    expect(ref).not.toBeNull()
    expect(ref?.mime).toBe('image/png')
    expect(ref?.bytes).toBeGreaterThan(0)
    expect(readdirSync(mcpArtifactDir(root))).toEqual([ref?.name])
  })

  it('svg 一律不收：它是可执行内容，只能走 <img>，不做产物', () => {
    const before = readdirSync(root).length
    expect(saveMcpImage(root, { mime: 'image/svg+xml', base64: PNG, index: 0, now: () => FIXED })).toBeNull()
    expect(readdirSync(root).length).toBe(before)
  })

  it('空内容 / 超上限都不写盘（超上限若照写，界面会被一张巨图卡死）', () => {
    expect(saveMcpImage(root, { mime: 'image/png', base64: '', index: 0, now: () => FIXED })).toBeNull()
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 10).toString('base64')
    expect(saveMcpImage(root, { mime: 'image/png', base64: huge, index: 0, now: () => FIXED })).toBeNull()
    expect(readdirSync(root)).toHaveLength(0)
  })

  it('同一时刻的不同序号不撞名；两张都能按各自名字读回来', () => {
    const dir = mcpArtifactDir(root)
    mkdirSync(dir, { recursive: true })
    const a = mcpArtifactName(FIXED, 0, '.png')
    const b = mcpArtifactName(FIXED, 1, '.png')
    expect(a).not.toBe(b)
    writeFileSync(join(dir, a), 'x')
    writeFileSync(join(dir, b), 'y')
    // 读取侧按名字放行（说明生成的名字确实落在白名单形状内），且内容不串
    expect(readMcpImageDataUrl(root, a)).toContain(Buffer.from('x').toString('base64'))
    expect(readMcpImageDataUrl(root, b)).toContain(Buffer.from('y').toString('base64'))
  })
})

describe('读取侧：越界名与缺失都不给内容', () => {
  // ⚠️ 这些名字必须**指向一个真存在的文件**：不种文件的话，去掉白名单也照样返回 null
  //（文件不在而已），判据就恒绿 —— 变异 M21 实测正是如此，补种之后才红。
  it('越界名一律 null：哪怕目标文件真的存在也不去拼路径', () => {
    writeFileSync(join(root, 'secret.png'), 'TOP-SECRET')
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes', 'a.png'), 'NOTES')
    for (const name of ['../root-secret.png', '../notes/a.png', 'notes/a.png', 'mcp-artifacts/x.png', '']) {
      expect(readMcpImageDataUrl(root, name)).toBeNull()
    }
    // 绝对路径同理：形状不合规就拒，不给它算到盘上任何位置的机会
    expect(readMcpImageDataUrl(root, join(root, 'secret.png'))).toBeNull()
  })

  it('白名单放行的是自己生成的名字：同目录下的别的文件读不到（防的是界面回传任意路径）', () => {
    const dir = mcpArtifactDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'someone-elses-file.png'), 'X')
    expect(readMcpImageDataUrl(root, 'someone-elses-file.png')).toBeNull()
  })

  it('名字合规但文件已被清 → null，不抛', () => {
    const ref = saveMcpImage(root, { mime: 'image/png', base64: PNG, index: 0, now: () => FIXED })
    rmSync(join(mcpArtifactDir(root), ref?.name ?? 'x'))
    expect(readMcpImageDataUrl(root, ref?.name ?? '')).toBeNull()
  })
})

describe('保留策略：截图是过程资产，可清', () => {
  it('超出上限按 mtime 留最新 N 张，返回**实际**删掉的张数', () => {
    const dir = mcpArtifactDir(root)
    mkdirSync(dir, { recursive: true })
    const total = MAX_MCP_ARTIFACTS + 5
    for (let i = 0; i < total; i++) {
      const name = mcpArtifactName(new Date(Date.UTC(2026, 8, 24, 2, 0, i)), i, '.png')
      writeFileSync(join(dir, name), PNG)
      // mtime 逐个错开：不手动设的话，同毫秒写入会让"谁是最新的"不确定（跨平台计时器粒度坑）
      const t = 1_800_000_000 + i
      utimesSync(join(dir, name), t, t)
    }
    expect(pruneMcpArtifacts(dir)).toBe(5)
    expect(readdirSync(dir)).toHaveLength(MAX_MCP_ARTIFACTS)
    // 留下的必须是最新的 40 张（序号 5..44）
    const kept = readdirSync(dir).sort()
    expect(kept.some((n) => n.includes('-0-'))).toBe(false)
    expect(kept.some((n) => n.includes('-44-'))).toBe(true)
  })

  it('目录不存在 → 0，不抛（首次运行就是这个状态）', () => {
    expect(pruneMcpArtifacts(join(root, 'nope'))).toBe(0)
  })
})
