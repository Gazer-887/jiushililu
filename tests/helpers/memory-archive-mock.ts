// 内存版**归档区**（plan53 片 1）：给各测试文件的假 backend 共用。
// 命名口径唯一真源是 `@shared/memory` 的 `archivedFileName` / `parseArchivedFileName` ——
// 假后端自己编一套命名，就等于把真实迁移路径测了个寂寞。
// 归档正文存在**独立 Map**（真实布局是独立目录，`listFiles()` 天然看不到），`read` 由这里统一兜住。

import { archivedFileName, parseArchivedFileName } from '@shared/memory'

// 同一毫秒内连续归档会撞名，测试里推进时刻保证唯一（真实实现落 fs，靠目录里已有文件天然不撞）
let tick = 0

export interface ArchiveMock {
  backend: {
    read(file: string): string | null
    archive(file: string): string | null
    listArchived(): string[]
    restoreFrom(archivedFile: string): string | null
  }
  /** 归档区本体，供断言直接看正文 */
  archived: Map<string, string>
}

export function createArchiveMock(opts: {
  files: Map<string, string>
  notesRoot: string
  archRoot: string
  /** 假后端自己的其它目录（如 candidates/）—— read 在 notes、归档区都查不到时问它 */
  fallback?: (file: string) => string | null
}): ArchiveMock {
  const archived = new Map<string, string>()
  const { files, notesRoot, archRoot } = opts
  return {
    archived,
    backend: {
      read: (file) => files.get(file) ?? archived.get(file) ?? opts.fallback?.(file) ?? null,
      archive: (file) => {
        if (!file.startsWith(`${notesRoot}/`) || !file.endsWith('.md')) return null
        const text = files.get(file)
        if (text === undefined) return null
        const slug = file.slice(notesRoot.length + 1, -3)
        const to = `${archRoot}/${archivedFileName(slug, new Date(Date.now() + tick++))}`
        files.delete(file)
        archived.set(to, text)
        return to
      },
      listArchived: () => [...archived.keys()].sort(),
      restoreFrom: (archivedFile) => {
        const parsed = parseArchivedFileName(archivedFile.split('/').pop() ?? '')
        if (!parsed) return null
        const text = archived.get(archivedFile)
        if (text === undefined) return null
        const to = `${notesRoot}/${parsed.slug}.md`
        if (files.has(to)) return null // 与真实实现同口径：同名已存在绝不覆盖
        archived.delete(archivedFile)
        files.set(to, text)
        return to
      }
    }
  }
}
