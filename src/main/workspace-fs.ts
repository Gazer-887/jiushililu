import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Attachment } from '@shared/ipc'
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

// 工作区文件系统服务（plan7 批 A）—— 右抽屉「文件」页签的数据源。
//
// **只读**。写操作（新建/重命名/删除）刻意留到批 A2，原因：
//   R4 的检查点钩子挂在 Agent 工具链（file-tools）上。界面若直接写文件就**绕过检查点**——
//   用户在文件树里删掉一个文件，回滚面板里什么都没记，退不回来。
//   要做写操作，得先让界面与 Agent 走**同一条写入路径**，否则等于开了个绕过检查点的后门。
//
// 路径门控**复用 Agent 那一套**（resolveInsideWorkspace）：边界规则只该有一份，
// 界面和 Agent 适用同一条线，否则两套规则迟早分叉。

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
    return {
      ok: true,
      rel,
      content: slice.toString('utf8'),
      size: st.size,
      ...(truncated ? { truncated: true } : {})
    }
  } catch (err) {
    return { ok: false, rel, content: '', size: 0, error: humanError(err) }
  }
}

/** 附件正文上限：64KB 够模型读懂，又不至于把上下文撑爆（超出截断并**标注**，不假装读全） */
export const ATTACH_LIMIT = 64 * 1024

/**
 * 把「工作区里的一个文件」读成附件（③ 文件拖进会话 / 文件选择框 **共用**）。
 *
 * 两个入口只差"路径从哪来"，所以读取、体积上限、**工作区边界**都在这里定义一次 ——
 * 各写一份的话，迟早有一天两个入口的边界不一致（而"从系统拖一个外部文件进来"
 * 正是最容易踩到的那条）。
 *
 * `resolveInsideWorkspace` 同时做"解析相对路径"与"越界检查"，正好是这里需要的两件事。
 *
 * @throws 路径越界 / 文件不可读时抛错（错误信息是给用户看的人话）
 */
export async function readAttachment(
  workspaceRoot: string,
  pathOrRel: string
): Promise<Attachment> {
  const abs = resolveInsideWorkspace(workspaceRoot, pathOrRel)
  if (!abs) throw new Error('只能引用当前工作区内的文件（越界已被拒绝）')
  const buf = await readFile(abs)
  const truncated = buf.byteLength > ATTACH_LIMIT
  return {
    name: basename(abs),
    path: abs,
    content: buf.subarray(0, ATTACH_LIMIT).toString('utf8'),
    truncated
  }
}

/** 十六进制转储读多少字节 —— 够看出文件头特征，又不啰嗦 */
const HEX_HEAD_BYTES = 256

/**
 * 读**二进制**文件用于预览（plan7 批 A3）。
 *
 * 两条路：
 *   · **图片** → `data:` URL，直接能渲染；超过 `MAX_IMAGE_BYTES` 就只回元信息
 *   · **其余二进制** → 前 256 字节的十六进制转储（「**降级而不是放弃**」）
 *
 * 为什么不复用 `readWorkspaceFile`：那个返回的是 UTF-8 **文本**，
 * 二进制过它一趟会变成替换字符（U+FFFD），信息全丢；图片更是直接废掉。
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
