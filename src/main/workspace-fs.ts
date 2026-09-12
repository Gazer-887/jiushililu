import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
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
      // 冲突基线：编辑保存时带回来比对（见 FsReadResult.mtimeMs 的注释）
      mtimeMs: st.mtimeMs,
      ...(truncated ? { truncated: true } : {})
    }
  } catch (err) {
    return { ok: false, rel, content: '', size: 0, error: humanError(err) }
  }
}

/** 附件正文上限：64KB 够模型读懂，又不至于把上下文撑爆（超出截断并**标注**，不假装读全） */
export const ATTACH_LIMIT = 64 * 1024

/**
 * 把「一个文件」读成附件（③ 文件拖进会话 / 文件选择框 **共用**）。
 *
 * 两个入口只差"路径从哪来"，所以读取、体积上限、**边界规则**都在这里定义一次 ——
 * 各写一份的话，迟早有一天两个入口的边界不一致（而"从系统拖一个外部文件进来"
 * 正是最容易踩到的那条）。
 *
 * ## 边界规则（2026-09-12 用户定案，**两层**）
 *
 * · **绝对路径 = 主人在系统里明确拖/选进来的一个文件** → **放行**，即使在工作区外。
 *   返回的附件带 `outside: true`，界面上标成「工作区外」。
 *   依据：把一份文件拖进会话，是主人**显式**把这份内容交给模型 —— 和粘贴一段文字同级。
 *   拦下来保护不到任何东西，只会让人觉得"拖不进去"（旧版就是这样被报上来的）。
 * · **相对路径 = 工作区文件树自己给的载荷** → **必须落在工作区内**，`..` 一律拒绝。
 *   自家文件树不会产出越界路径，出现了就说明有问题，不该当成正常输入放行。
 *
 * ⚠️ Agent 自己读写文件的边界**一点没变**：`file-tools` / `workspace-write` /
 * `system-tools` 各走各的 `resolveInsideWorkspace`，与附件这条线不相干。
 *
 * @throws 相对路径越界 / 文件不可读时抛错（错误信息**自证现场**：带上路径与边界）
 */
export async function readAttachment(
  workspaceRoot: string,
  pathOrRel: string
): Promise<Attachment> {
  const isAbs = isAbsolute(pathOrRel)
  const inside = resolveInsideWorkspace(workspaceRoot, pathOrRel)
  if (!inside && !isAbs) {
    // 拒绝理由必须**自证现场**：只写"越界已被拒绝"的话，用户和排查者都不知道
    // 到底是哪个路径被拒了、当时的工作区边界又在哪 —— 2026-09-12 用户报拖拽失败时
    // 就卡在这里：一条消息四种可能（树里拖的 / 系统拖的 / 工作区换了 / 路径真的越界）
    // 全都能产生同一句话。把**被拒的路径**和**当前边界**都写进去，一眼就能定位。
    throw new Error(
      `工作区文件树给的路径越出了工作区（已拒绝：「${pathOrRel}」；当前工作区：${workspaceRoot}）`
    )
  }
  const abs = inside ?? resolve(pathOrRel)
  const outside = inside === null

  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (err) {
    // 读不了也要说清**是哪个文件**读不了 —— 否则界面上一句"文件不存在"等于没给线索
    throw new Error(`读不了这个文件（「${abs}」）：${humanError(err)}`)
  }

  const truncated = buf.byteLength > ATTACH_LIMIT
  return {
    name: basename(abs),
    path: abs,
    content: buf.subarray(0, ATTACH_LIMIT).toString('utf8'),
    truncated,
    ...(outside ? { outside: true } : {})
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
