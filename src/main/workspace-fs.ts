import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  MAX_ENTRIES,
  shouldSkipEntry,
  sortEntries,
  type FsEntry,
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
    const code = (err as NodeJS.ErrnoException).code
    const reason =
      code === 'ENOENT'
        ? '文件不存在或已被移动'
        : code === 'EACCES' || code === 'EPERM'
          ? '没有权限读取该文件'
          : err instanceof Error
            ? err.message
            : String(err)
    return { ok: false, rel, content: '', size: 0, error: reason }
  }
}
