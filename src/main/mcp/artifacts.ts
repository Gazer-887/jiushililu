// MCP 图片产物的落盘与读取（plan44 S2b）。
//
// 为什么不把 base64 直接塞进会话消息：截图一张数百 KB，而 `segments` 是**每次存档都整份写盘**的
// 本地资产 —— 存 base64 等于每轮把图片重写一遍（plan10 分层好不容易压下来的体积会原地反弹）。
// 所以只存引用（`ToolImageRef.name`），正文留在 `userData/mcp-artifacts/`。
//
// 三条硬约束：① 只收 png/jpeg（SVG 能带脚本，见 `fs-tree.ts` 那条红线）；
// ② 文件名**只由本模块生成**，读取侧按字符白名单校验 —— 名字从界面来，不给路径穿越留门；
// ③ 数量有上限，超出按 mtime 清：一次桌面操作能连点几十张，不清就是无声涨盘。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_IMAGE_BYTES } from '@shared/fs-tree'
import type { ToolImageRef } from '@shared/agent'

export const MCP_ARTIFACT_DIR = 'mcp-artifacts'
/** 最多留几张：截图是**过程资产**不是用户数据，可清；清的顺序按 mtime 从新到旧 */
export const MAX_MCP_ARTIFACTS = 40
/** 只收这两种 */
const ALLOWED_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg' }
/** 形状：`YYYYMMDDTHHMMSS-<序号>-<6 位十六进制>.<png|jpg>`。别的形状一律拒 */
const SAFE_NAME = /^[0-9]{8}T[0-9]{6}-[0-9]{1,3}-[0-9a-f]{6}\.(png|jpg)$/

export function mcpArtifactDir(root: string): string {
  return join(root, MCP_ARTIFACT_DIR)
}

/** 受限文件名：时刻由调用方给（测试要能钉住它），随机段取时刻的低位异或序号 */
export function mcpArtifactName(at: Date, index: number, ext: string): string {
  const digits = at.toISOString().replace(/[-:.TZ]/g, '')
  const rand = ((at.getTime() ^ (index * 7919)) >>> 0).toString(16).padStart(8, '0').slice(-6)
  return `${digits.slice(0, 8)}T${digits.slice(8, 14)}-${index}-${rand}${ext}`
}

/**
 * 存一张图并返回引用；不收的类型 / 空 / 超 `MAX_IMAGE_BYTES` 一律**不写并返回 null**。
 * 拒了要能回答"点了截图怎么没有图" —— 调用方必须把 null 的计数带到界面上，不许静默。
 */
export function saveMcpImage(
  root: string,
  opts: { mime: string; base64: string; index: number; now: () => Date }
): ToolImageRef | null {
  const ext = ALLOWED_EXT[opts.mime]
  if (ext === undefined) return null
  let buf: Buffer
  try {
    buf = Buffer.from(opts.base64, 'base64')
  } catch {
    return null
  }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null
  const dir = mcpArtifactDir(root)
  mkdirSync(dir, { recursive: true })
  const name = mcpArtifactName(opts.now(), opts.index, ext)
  writeFileSync(join(dir, name), buf)
  pruneMcpArtifacts(dir)
  return { name, mime: opts.mime, bytes: buf.length }
}

/** 按 mtime 留最新 N 张，返回**实际**删掉的张数（删不动的不算，也不抛 —— 占用/权限都不该让这次调用失败） */
export function pruneMcpArtifacts(dir: string, keep = MAX_MCP_ARTIFACTS): number {
  if (!existsSync(dir)) return 0
  const dated = readdirSync(dir)
    .filter((n) => SAFE_NAME.test(n))
    .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  let removed = 0
  for (const stale of dated.slice(keep)) {
    try {
      rmSync(join(dir, stale.n))
      removed++
    } catch {
      continue
    }
  }
  return removed
}

/**
 * 读成 data URL（界面 `<img src>` 用）。名字不合白名单**直接 null，不去拼路径**。
 * CSP 侧无需改动：生产 `img-src` 已含 data:，与现有图片预览同一根通路。
 */
export function readMcpImageDataUrl(root: string, name: string): string | null {
  if (!SAFE_NAME.test(name)) return null
  const p = join(mcpArtifactDir(root), name)
  if (!existsSync(p)) return null
  const mime = name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
}
