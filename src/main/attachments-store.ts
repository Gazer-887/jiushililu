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
  type ImageRef,
  type VideoRef
} from '@shared/content-parts'
import { mcpArtifactName } from './mcp/artifacts'

export const ATTACHMENTS_DIR = 'attachments'
/** 留最新几张（图片与视频同池）：被清掉的引用在出站时降级成一句人话，不把整段会话卡死（见 `readAttachmentImage`） */
export const MAX_ATTACHMENTS = 60

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  // 视频只放实测过的容器（plan57 片⑤ / K54）
  'video/mp4': '.mp4'
}

export function attachmentsDir(root: string): string {
  return join(root, ATTACHMENTS_DIR)
}

/**
 * 存一个媒体附件并返回引用。**类型不收 / 空 / 超上限一律不写并返回 null** ——
 * 拒了要能在界面上说清是哪一个、为什么，调用方不许把 null 当成"没这回事"。
 * 上限按类型分：图片 5 MB、视频 20 MB（`maxBytes` 由调用方按 MIME 选好并已在预检处报过人话）。
 */
export function saveAttachmentMedia(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number }
): ImageRef | VideoRef | null {
  const ext = EXT_BY_MIME[opts.mime]
  if (ext === undefined) return null
  const cap = opts.maxBytes ?? MAX_OUTBOUND_IMAGE_BYTES
  if (opts.buf.length === 0 || opts.buf.length > cap) return null
  const dir = attachmentsDir(root)
  mkdirSync(dir, { recursive: true })
  // 名字撞车就顺延序号：同一毫秒连存两个（index 都是 0）会算出同一个名字，
  // 后一个把前一个**覆盖掉** —— 于是用户附了两个、模型只看到一个，且不报任何错。
  let index = opts.index ?? 0
  let ref = mcpArtifactName(opts.now(), index, ext)
  while (existsSync(join(dir, ref))) ref = mcpArtifactName(opts.now(), ++index, ext)
  writeFileSync(join(dir, ref), opts.buf)
  pruneAttachments(root)
  const type = opts.mime.startsWith('video/') ? 'video' : 'image'
  return { type, mime: opts.mime, ref, bytes: opts.buf.length } as ImageRef | VideoRef
}

/** 图片入口（返回类型收窄，免得调用方到处 `as`） */
export function saveAttachmentImage(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number }
): ImageRef | null {
  const got = saveAttachmentMedia(root, opts)
  return got?.type === 'image' ? got : null
}

/** 视频入口（同上） */
export function saveAttachmentVideo(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number }
): VideoRef | null {
  const got = saveAttachmentMedia(root, opts)
  return got?.type === 'video' ? got : null
}

/**
 * 按引用读回字节。形状不合法 = 有人往 ref 里塞了路径 ⇒ 抛；文件不在 = 被清理或换机 ⇒ 也抛，
 * 但文案要能回答"我上午发的那张图怎么没了"。两种都由调用方决定降级形状，本层不静默返回空。
 */
export function readAttachmentMedia(root: string, ref: string): Buffer {
  if (!isSafeAttachmentRef(ref)) throw new Error('附件引用形状不合法')
  const file = join(attachmentsDir(root), ref)
  if (!existsSync(file)) throw new Error(`附件媒体文件不存在：${ref}`)
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
