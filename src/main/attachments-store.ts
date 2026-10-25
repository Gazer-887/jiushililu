// 附件图片的落盘与读取（plan57 片③，D-146 A：磁盘存真值、历史放 marker、出站那一刻才物化 base64）。
//
// 为什么不并进 `mcp-artifacts/`：那边是**过程资产**（截图，随时可清），这边是用户明确发出去的图，
// 混进同一个目录就等于"清截图顺手清掉会话里的图"。两条线各自配额、各自清理。
// 三条硬约束：① 原模型类型/5MiB图片/20MiB视频上限不扩大；② 文件名受限，读取处核真实路径；
// ③ 与本地资产共享1GiB预算，不按数量自动删除历史。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_VIDEO_BYTES,
  isSafeAttachmentRef,
  type ImageRef,
  type VideoRef
} from '@shared/content-parts'
import { mcpArtifactName } from './mcp/artifacts'
import { AssetBudget, assetBudgetForRoot, assetsDir, mediaAssetsDir, readAsset, storeAssetBuffer, type AssetPublisher } from './preview-assets'

export const ATTACHMENTS_DIR = 'attachments'
/** 旧手动清理工具的默认数量，仅保留兼容；保存热路径不调用淘汰。 */
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
  return mediaAssetsDir(root)
}

/**
 * 存一个媒体附件并返回引用。**类型不收 / 空 / 超上限一律不写并返回 null** ——
 * 拒了要能在界面上说清是哪一个、为什么，调用方不许把 null 当成"没这回事"。
 * 上限按类型分：图片 5 MB、视频 20 MB（`maxBytes` 由调用方按 MIME 选好并已在预检处报过人话）。
 */
export function saveAttachmentMedia(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number; budget?: AssetBudget; publish?: AssetPublisher }
): ImageRef | VideoRef | null {
  const ext = EXT_BY_MIME[opts.mime]
  if (ext === undefined) return null
  const nativeCap = opts.mime.startsWith('video/') ? MAX_OUTBOUND_VIDEO_BYTES : MAX_OUTBOUND_IMAGE_BYTES
  const cap = Math.min(opts.maxBytes ?? nativeCap, nativeCap)
  if (opts.buf.length === 0 || opts.buf.length > cap) return null
  const dir = attachmentsDir(root)
  // 名字撞车就顺延序号：同一毫秒连存两个（index 都是 0）会算出同一个名字，
  // 后一个把前一个**覆盖掉** —— 于是用户附了两个、模型只看到一个，且不报任何错。
  const preferred = mcpArtifactName(opts.now(), opts.index ?? 0, ext)
  const stored = storeAssetBuffer(opts.buf, preferred, dir, opts.budget ?? assetBudgetForRoot(root), preferred, opts.publish)
  if (!stored.ok) return null
  const ref = stored.asset.assetId
  // ⚠️ plan74 R4 修正：**不再自动淘汰**。旧行为每存一张就 prune 到 60 张，第 61 张会删掉
  // 第 1 张 —— 用户上午发的图下午就没了（Spec R4 反例实测坐实：存 61 份后第一份被删）。
  // 现按「历史不淘汰」：库可增长，新增由各自上限约束，旧存量一律保留。pruneAttachments
  // 保留为手动清理工具（设置项/用户主动），不在保存热路径调用。
  const type = opts.mime.startsWith('video/') ? 'video' : 'image'
  return { type, mime: opts.mime, ref, bytes: opts.buf.length } as ImageRef | VideoRef
}

/** 图片入口（返回类型收窄，免得调用方到处 `as`） */
export function saveAttachmentImage(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number; budget?: AssetBudget; publish?: AssetPublisher }
): ImageRef | null {
  const got = saveAttachmentMedia(root, opts)
  return got?.type === 'image' ? got : null
}

/** 视频入口（同上） */
export function saveAttachmentVideo(
  root: string,
  opts: { mime: string; buf: Buffer; index?: number; now: () => Date; maxBytes?: number; budget?: AssetBudget; publish?: AssetPublisher }
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
  return readAsset(assetsDir(root), ref)
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
