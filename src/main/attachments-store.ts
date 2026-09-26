// 附件图片的落盘与读取（plan57 片③，D-146 A：磁盘存真值、历史放 marker、出站那一刻才物化 base64）。
//
// 为什么不并进 `mcp-artifacts/`：那边是**过程资产**（截图，随时可清），这边是用户明确发出去的图，
// 混进同一个目录就等于"清截图顺手清掉会话里的图"。两条线各自配额、各自清理。
// 三条硬约束照抄那边并被共享层钉住：① 只收模型真吃得下的类型；② 文件名只由本模块生成，
// 读取侧按字符白名单校验（ref 从存档来，收路径就是给穿越留门）；③ 数量有上限，超出按 mtime 清。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  isSafeAttachmentRef,
  type ImageRef
} from '@shared/content-parts'
import { mcpArtifactName } from './mcp/artifacts'

export const ATTACHMENTS_DIR = 'attachments'
/** 留最新几张：被清掉的引用在出站时降级成一句人话，不把整段会话卡死（见 `readAttachmentImage`） */
export const MAX_ATTACHMENTS = 60

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

export function attachmentsDir(root: string): string {
  return join(root, ATTACHMENTS_DIR)
}

/**
 * 存一张图并返回引用。**类型不收 / 空 / 超 `MAX_OUTBOUND_IMAGE_BYTES` 一律不写并返回 null** ——
 * 拒了要能在界面上说清是哪张、为什么，调用方不许把 null 当成"没这回事"。
 */
export function saveAttachmentImage(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date }
): ImageRef | null {
  const ext = EXT_BY_MIME[opts.mime]
  if (ext === undefined) return null
  if (opts.buf.length === 0 || opts.buf.length > MAX_OUTBOUND_IMAGE_BYTES) return null
  const dir = attachmentsDir(root)
  mkdirSync(dir, { recursive: true })
  // 名字撞车就顺延序号：同一秒连附两张（各自一次调用、index 都是 0）会算出同一个名字，
  // 后一张把前一张**覆盖掉** —— 于是用户附的两张图在模型那边变成同一张，且不报任何错。
  let index = opts.index ?? 0
  let ref = mcpArtifactName(opts.now(), index, ext)
  while (existsSync(join(dir, ref))) ref = mcpArtifactName(opts.now(), ++index, ext)
  writeFileSync(join(dir, ref), opts.buf)
  pruneAttachments(root)
  return { type: 'image', mime: opts.mime, ref, bytes: opts.buf.length }
}

/**
 * 按引用读回字节。形状不合法 = 有人往 ref 里塞了路径 ⇒ 抛；文件不在 = 被清理或换机 ⇒ 也抛，
 * 但文案要能回答"我上午发的那张图怎么没了"。两种都由调用方决定降级形状，本层不静默返回空。
 */
export function readAttachmentImage(root: string, ref: string): Buffer {
  if (!isSafeAttachmentRef(ref)) throw new Error('附件引用形状不合法')
  const file = join(attachmentsDir(root), ref)
  if (!existsSync(file)) throw new Error(`附件图片文件不存在：${ref}`)
  return readFileSync(file)
}

/** 按 mtime 留最新 N 张，返回**实际**删掉的张数（删不动的不算，占用/权限都不该让这次调用失败） */
export function pruneAttachments(root: string, keep = MAX_ATTACHMENTS): number {
  const dir = attachmentsDir(root)
  if (!existsSync(dir)) return 0
  const dated = readdirSync(dir)
    .filter((n) => isSafeAttachmentRef(n))
    .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  let removed = 0
  for (const stale of dated.slice(keep)) {
    try {
      rmSync(join(dir, stale.n))
      removed++
    } catch {
      // 被占用就留给下一轮 —— 清不动不是失败，更不该让"存这张图"跟着失败
    }
  }
  return removed
}
