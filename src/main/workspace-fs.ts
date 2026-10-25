import { contentRevision } from './file-revision'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Attachment } from '@shared/ipc'
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_VIDEO_BYTES,
  OUTBOUND_IMAGE_MIMES,
  outboundVideoMimeOf
} from '@shared/content-parts'
import { saveAttachmentImage, saveAttachmentVideo } from './attachments-store'
import { ingestAsset, assetsDir, readAssetPrefix, type AssetBudget, type AssetIdentity, type AssetPublisher } from './preview-assets'
import { previewMimeOf } from '@shared/conversation-preview'
import {
  MAX_ENTRIES,
  MAX_IMAGE_BYTES,
  hexDump,
  imageMimeOf,
  shouldSkipEntry,
  sortEntries,
  type FsEntry,
  type FsBinaryResult,
  type FsListResult,
  type FsReadResult
} from '@shared/fs-tree'
import { resolveInsideWorkspace } from './agent/guard'

// 工作区文件系统服务（plan7 批 A）—— 右抽屉「文件」页签的数据源。**只读**。
// 写操作刻意推迟到批 A2：检查点钩子挂在 Agent 工具链（file-tools）上，界面若直接写文件就
// **绕过检查点** —— 用户在文件树里删掉一个文件，回滚面板里什么都没记、退不回来。
// 路径门控**复用 Agent 那一套**（resolveInsideWorkspace）：边界规则只该有一份，否则迟早分叉。

/** 预览上限：256KB 够看内容，又不至于把界面拖死 */
const MAX_PREVIEW_BYTES = 256 * 1024

/** 列一层目录（懒加载：展开哪个查哪个，不做整树递归） */
export async function listWorkspaceDir(workspaceRoot: string, rel = ''): Promise<FsListResult> {
  const abs = rel === '' ? resolve(workspaceRoot) : resolveInsideWorkspace(workspaceRoot, rel)
  if (!abs) {
    return { ok: false, entries: [], error: `路径「${rel}」越出工作区边界，拒绝访问` }
  }

  const rootLevel = rel === '' || rel === '.'
  try {
    const dirents = await readdir(abs, { withFileTypes: true })
    const entries: FsEntry[] = []

    for (const d of dirents) {
      const kind: 'file' | 'dir' = d.isDirectory() ? 'dir' : 'file'
      if (shouldSkipEntry(d.name, kind, rootLevel)) continue

      const childRel = rel === '' || rel === '.' ? d.name : `${rel}/${d.name}`.replace(/\\/g, '/')
      const entry: FsEntry = { name: d.name, rel: childRel, kind }

      // 文件才带大小；取大小失败（孤立符号链接等）就省略，不让整个列表失败
      if (kind === 'file') {
        try {
          const st = await stat(join(abs, d.name))
          entry.size = st.size
        } catch {
          // 省略 size
        }
      }

      entries.push(entry)
      if (entries.length >= MAX_ENTRIES) {
        return { ok: true, entries: sortEntries(entries), truncated: true }
      }
    }

    return { ok: true, entries: sortEntries(entries) }
  } catch (err) {
    // 人话错误（不给模型看的，是给用户看的）
    const code = (err as NodeJS.ErrnoException).code
    const reason =
      code === 'ENOENT'
        ? '目录不存在或已被移动'
        : code === 'EACCES' || code === 'EPERM'
          ? '没有权限读取该目录'
          : code === 'ENOTDIR'
            ? '该路径不是一个目录'
            : err instanceof Error
              ? err.message
              : String(err)
    return { ok: false, entries: [], error: reason }
  }
}

/** 把 fs 的错误码翻成人话（给用户看的，不是给模型看的） */
function humanError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return '文件不存在或已被移动'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取该文件'
  return err instanceof Error ? err.message : String(err)
}

/** 读文件内容用于预览（限 256KB；超限截断并明确告知，不假装读全了） */
export async function readWorkspaceFile(workspaceRoot: string, rel: string): Promise<FsReadResult> {
  const abs = resolveInsideWorkspace(workspaceRoot, rel)
  if (!abs) {
    return { ok: false, rel, content: '', size: 0, error: `路径「${rel}」越出工作区边界，拒绝读取` }
  }

  try {
    const st = await stat(abs)
    if (!st.isFile()) {
      return { ok: false, rel, content: '', size: 0, error: '该路径不是文件' }
    }
    const buf = await readFile(abs)
    const truncated = buf.byteLength > MAX_PREVIEW_BYTES
    const slice = truncated ? buf.subarray(0, MAX_PREVIEW_BYTES) : buf
    const content = slice.toString('utf8')
    return {
      ok: true,
      rel,
      content,
      size: st.size,
      // 冲突基线：编辑保存时带回来比对（见 FsReadResult.mtimeMs 的注释）
      mtimeMs: st.mtimeMs,
      revision: contentRevision(buf),
      ...(truncated ? { truncated: true } : {}),
      // 有损解码判据（plan13 批 B 实测）：原文不是合法 UTF-8（GBK / 二进制）时 `toString('utf8')`
      // 会把坏字节换成 U+FFFD，**再编码回去不等于原字节** → "读进来再写回去"必然损坏它。
      // ⚠️ 用**整个** buf 判（不是 slice）：截断可能切在多字节字符中间，拿切片判会把合法文件误判成有损。
      lossy: !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
    }
  } catch (err) {
    return { ok: false, rel, content: '', size: 0, error: humanError(err) }
  }
}

/** 附件正文上限：64KB 够模型读懂，又不至于把上下文撑爆（超出截断并**标注**，不假装读全） */
export const ATTACH_LIMIT = 64 * 1024

/**
 * 二进制判据（与 file-tools 的 read_file 同一份）：前 8KiB 有无 NUL。
 * ⚠️ 只做 NUL 探测，不是 magic-byte 识别、也不是 UTF 编码探测 —— 别拿它当"认格式"用。
 */
function hasBinaryHead(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

/** 文本语义 hint（这些类型「准备装入正文」，装之前必须过 NUL 闸） */
function isTextHint(hint: string | null): boolean {
  return !hint || hint.startsWith('text/') || hint === 'application/json' || hint === 'application/xml'
}

/** 本次摄取登记是事务的一部分，返回登记后的附件和可撤销身份。 */
export type AttachmentPublisher = (attachment: Attachment) => { attachment: Attachment; rollback: () => void }

/**
 * 把「一个文件」读成附件（③ 文件拖进会话 / 文件选择框 **共用** —— 两处各写一份迟早边界不一致）。
 *
 * 边界规则（2026-09-12 用户定案，**两层**）：
 * · **绝对路径**（系统资源管理器拖/选进来的）→ **放行**，即使在工作区外（附件带 `outside: true`）：
 *   那是主人**显式**把内容交给模型，与粘贴一段文字同级 —— 拦下来保护不到任何东西，只会让人觉得"拖不进去"。
 * · **相对路径**（工作区文件树给的载荷）→ **必须落在工作区内**，`..` 一律拒绝（自家文件树不会产出越界路径）。
 * ⚠️ Agent 自己读写文件的边界**一点没变**：`file-tools` / `workspace-write` / `system-tools` 各走各的
 * `resolveInsideWorkspace`，与附件这条线不相干。
 *
 * @throws 相对路径越界 / 文件不可读时抛错（错误信息**自证现场**：带上路径与边界）
 */
export async function readAttachment(
  workspaceRoot: string,
  pathOrRel: string,
  /** 图片落点（`userData`）。没有这条路可走时图片只能被拒 —— 但**不许**退化成"按文本硬读" */
  userDataDir: string,
  /**
   * 预览预算（plan74）：给了才对非媒体二进制文件（PDF/音频/Office）做「摄取供本地预览」。
   * 不传 = 旧行为（这类文件直接拒）。由调用方注入进程单例，本模块不持有全局预算。
   */
  previewBudget?: AssetBudget,
  publish?: AttachmentPublisher
): Promise<Attachment> {
  const isAbs = isAbsolute(pathOrRel)
  const inside = resolveInsideWorkspace(workspaceRoot, pathOrRel)
  if (!inside && !isAbs) {
    // 拒绝理由必须**自证现场**：只写"越界已被拒绝"，用户和排查者都不知道是哪个路径被拒、边界在哪
    // —— 2026-09-12 用户报拖拽失败时就卡在这（四种可能路径都能产生同一句话）。
    throw new Error(
      `工作区文件树提供的路径越出了工作区（已拒绝：「${pathOrRel}」；当前工作区：${workspaceRoot}）`
    )
  }
  const abs = inside ?? resolve(pathOrRel)
  const outside = inside === null
  const name = basename(abs)
  let published: Attachment | undefined
  const publication = (hint: string | null, media?: 'image' | 'video'): AssetPublisher => (asset: AssetIdentity) => {
    const prefix = isTextHint(hint) ? readAssetPrefix(assetsDir(userDataDir), asset.assetId, ATTACH_LIMIT) : null
    // 文本候选装正文前先过 NUL 闸（与 read_file 同判据）：文本扩展名的假文本二进制按未知二进制降级 ——
    // content 留空、不填模型 parts，本地快照与归属保留。⚠️ 只做 NUL 探测，不是格式识别。
    const mime = prefix && hasBinaryHead(prefix) ? 'application/octet-stream' : hint ?? 'text/plain'
    const base: Attachment = {
      name, path: abs, content: '', truncated: false, bytes: asset.bytes,
      ...(outside ? { outside: true } : {}),
      preview: { assetId: asset.assetId, digest: asset.digest, mime },
      ...(media === 'image' ? { image: { type: 'image' as const, mime, ref: asset.assetId, bytes: asset.bytes } } : {}),
      ...(media === 'video' ? { video: { type: 'video' as const, mime, ref: asset.assetId, bytes: asset.bytes } } : {})
    }
    // 文本正文读取也在结算前。读取异常不能留下已提交孤儿附件。
    if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
      base.content = prefix?.toString('utf8') ?? ''
      base.truncated = asset.bytes > ATTACH_LIMIT
    }
    if (!publish) { published = base; return }
    const result = publish(base)
    published = result.attachment
    return result.rollback
  }
  const st = await stat(abs).catch(err => { throw new Error(`无法读取该文件（「${abs}」）：${humanError(err)}`) })
  const knownImage = imageMimeOf(name)
  const modelImage = knownImage && (OUTBOUND_IMAGE_MIMES as readonly string[]).includes(knownImage)
  const knownVideo = outboundVideoMimeOf(name)
  const localOnlyMedia = (knownImage && st.size > MAX_OUTBOUND_IMAGE_BYTES) || (knownVideo && st.size > MAX_OUTBOUND_VIDEO_BYTES)
  // plan74：可本地预览的非媒体格式（PDF/音频/Office）**按扩展名优先识别并摄取**——
  // 放在二进制闸之前：文本型 PDF（无 NUL，如部分生成器产物）此前会被当文本读、不触发摄取。
  // 这些格式本就只服务本地预览（localFiles），不该进模型正文。
  const pmEarly = previewMimeOf(name)
  if (previewBudget && ((!modelImage && !knownVideo) || localOnlyMedia)) {
    const ing = ingestAsset(abs, name, assetsDir(userDataDir), previewBudget, publication(pmEarly))
    if (ing.ok) {
      if (!published) throw new Error('附件登记未完成')
      return published
    }
    throw new Error(`「${name}」无法加入预览：${ing.reason}`)
  }
  // 已知媒体先按原模型上限stat预检，不先把超限大文件整份读入内存。
  if (knownImage && st.size > MAX_OUTBOUND_IMAGE_BYTES) throw new Error(`「${name}」超过单张图5 MB上限`)
  if (knownVideo && st.size > MAX_OUTBOUND_VIDEO_BYTES) throw new Error(`「${name}」超过单段视频20 MB上限`)
  let buf: Buffer
  try { buf = await readFile(abs) } catch (err) { throw new Error(`无法读取该文件（「${abs}」）：${humanError(err)}`) }
  const bytes = buf.byteLength
  // 二进制闸：**与 agent/tools/file-tools.ts 的 read_file 用同一判据**（前 8KB 有无 NUL）。
  // 此前附件这条线直接 toString('utf8') ⇒ PNG/JPG 被读成一串 U+FFFD 塞进上下文，
  // 用户看到的是"截断"，真相是"内容全废"（plan57 病根；三处注释写过这事，只有 read_file 装了闸）。
  if (hasBinaryHead(buf)) {
    // 图片走引用制（plan57 片③）：落盘 + 只把引用带回去，base64 到出站那一刻才物化。
    // 扩展名表**只作补充**：真判据仍是上面那次 NUL 探测 —— 改了后缀的 png 也进不来文本这条路。
    const mime = imageMimeOf(name)
    if (mime && (OUTBOUND_IMAGE_MIMES as readonly string[]).includes(mime)) {
      if (bytes > MAX_OUTBOUND_IMAGE_BYTES) {
        throw new Error(
          `「${name}」约 ${Math.round(bytes / 1024 / 1024)} MB，超过单张图 ${Math.round(MAX_OUTBOUND_IMAGE_BYTES / 1024 / 1024)} MB 上限（先压缩或裁剪后再附）`
        )
      }
      const image = saveAttachmentImage(userDataDir, { mime, buf, index: 0, now: () => new Date(), ...(previewBudget ? { budget: previewBudget } : {}), publish: publication(mime, 'image') })
      if (!image) throw new Error(`「${name}」未能存为图片附件，请重试或改用 png/jpg/gif/webp`)
      if (published) return published
      return { name, path: abs, content: '', truncated: false, bytes, image }
    }
    // 视频（plan57 片⑤ / K54）：同一套引用制，只是上限与 MIME 不同。
    // ⚠️ 容器格式**只放实测过的 mp4**：mov / webm 未实测 ⇒ 不收，别拿"应该差不多"猜一个出去。
    const videoMime = outboundVideoMimeOf(name)
    if (videoMime) {
      if (bytes > MAX_OUTBOUND_VIDEO_BYTES) {
        throw new Error(
          `「${name}」约 ${Math.round(bytes / 1024 / 1024)} MB，超过单段视频 ${Math.round(MAX_OUTBOUND_VIDEO_BYTES / 1024 / 1024)} MB 上限（先剪短或降码率后再附）`
        )
      }
      const video = saveAttachmentVideo(userDataDir, {
        mime: videoMime,
        buf,
        index: 0,
        now: () => new Date(),
        maxBytes: MAX_OUTBOUND_VIDEO_BYTES,
        ...(previewBudget ? { budget: previewBudget } : {}),
        publish: publication(videoMime, 'video')
      })
      if (!video) throw new Error(`「${name}」未能存为视频附件，请重试或改用 mp4`)
      if (published) return published
      return { name, path: abs, content: '', truncated: false, bytes, video }
    }
    // plan74：非媒体二进制文件（PDF/音频/Office 等）——给了预览预算才摄取，否则旧行为（拒）。
    const pm = previewMimeOf(name)
    if (pm && previewBudget) {
      const ing = ingestAsset(abs, name, assetsDir(userDataDir), previewBudget, publication(pm))
      if (ing.ok) {
        if (published) return published
        return {
          name,
          path: abs,
          content: '',
          truncated: false,
          bytes: ing.asset.bytes,
          ...(outside ? { outside: true } : {}),
          preview: { assetId: ing.asset.assetId, digest: ing.asset.digest, mime: pm }
        }
      }
      // 摄取失败（超 50MiB / 预算满）：如实报因，不假装能预览
      throw new Error(`「${name}」无法加入预览：${ing.reason}`)
    }
    throw new Error(
      // ⚠️ 主语必须是**本应用的通路**，不是"模型能收什么"：全模态模型也在收 mp4 被这句挡过，
      // 用户据此以为模型不支持、回来问了一遍（09-27 装机点验现场）。边界与出路都要说准。
      `「${name}」是无法识别的二进制文件，当前附件通路只支持文本、图片（png/jpg/gif/webp）、视频（mp4）与可本地预览的文档/音频`
    )
  }

  const truncated = buf.byteLength > ATTACH_LIMIT
  return {
    name: basename(abs),
    path: abs,
    content: buf.subarray(0, ATTACH_LIMIT).toString('utf8'),
    truncated,
    bytes,
    ...(outside ? { outside: true } : {})
  }
}

/** 十六进制转储读多少字节 —— 够看出文件头特征，又不啰嗦 */
const HEX_HEAD_BYTES = 256

/**
 * 读**二进制**文件用于预览（plan7 批 A3）。
 * **图片** → `data:` URL（超过 `MAX_IMAGE_BYTES` 只回元信息）；**其余二进制** → 前 256 字节十六进制转储（降级而不是放弃）。
 * ⚠️ 不许复用 `readWorkspaceFile`：那个返回 UTF-8 **文本**，二进制过一趟变成替换字符（U+FFFD）信息全丢、图片直接废掉。
 */
export async function readWorkspaceBinary(
  workspaceRoot: string,
  rel: string
): Promise<FsBinaryResult> {
  const abs = resolveInsideWorkspace(workspaceRoot, rel)
  if (!abs) {
    return { ok: false, rel, size: 0, error: `路径「${rel}」越出工作区边界，拒绝访问` }
  }

  try {
    const st = await stat(abs)
    if (!st.isFile()) return { ok: false, rel, size: 0, error: '该路径不是文件' }

    const name = rel.split(/[\\/]/).pop() ?? rel
    const mime = imageMimeOf(name)

    if (mime) {
      // 超限就**只回元信息**：别把几十 MB 的 base64 塞进 IPC 结构化克隆
      if (st.size > MAX_IMAGE_BYTES) return { ok: true, rel, size: st.size, tooLarge: true }
      const buf = await readFile(abs)
      return {
        ok: true,
        rel,
        size: st.size,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`
      }
    }

    // 非图片：**只读文件头那一段**（不为了 256 字节把整个文件读进内存）
    const fh = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(HEX_HEAD_BYTES)
      const { bytesRead } = await fh.read(buf, 0, HEX_HEAD_BYTES, 0)
      return {
        ok: true,
        rel,
        size: st.size,
        hexHead: hexDump(buf.subarray(0, bytesRead), HEX_HEAD_BYTES)
      }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return { ok: false, rel, size: 0, error: humanError(err) }
  }
}
