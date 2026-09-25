// 内存版**归档区 + 候选回收站**（plan53 片 1 / plan56 片③）：给各测试文件的假 backend 共用。
// 命名口径唯一真源是 `@shared/memory` 的 `archivedFileName` / `parseArchivedFileName` ——
// 假后端自己编一套命名，就等于把真实迁移路径测了个寂寞。
// 归档正文存在**独立 Map**（真实布局是独立目录，`listFiles()` 天然看不到），`read` 由这里统一兜住。

import { archivedFileName, parseArchivedFileName } from '@shared/memory'

// 同一毫秒内连续归档会撞名，测试里推进时刻保证唯一（真实实现落 fs，靠目录里已有文件天然不撞）
let tick = 0

export interface ArchiveMock {
  backend: {
    read(file: string): string | null
    /**
     * 与真后端同口径：`remove` 也覆盖三处（notes / candidates / archived）。
     * ⚠️ 各文件自己那份 `remove` 只认 notes —— 归档件于是"删不掉"，K28 清空归档的判据就是这么暴露的。
     * 这里给一份 faithful 实现，spread 在自带 remove 之后即生效。
     */
    remove(file: string): boolean
    archive(file: string): string | null
    listArchived(): string[]
    restoreFrom(archivedFile: string): string | null
    /** plan56 片③：四个新口子与真后端同口径 —— `read` / `remove` 都够不到回收站那一处 */
    reject(file: string): string | null
    listRejected(): string[]
    readRejected(rejectedFile: string): string | null
    restoreRejectedFrom(rejectedFile: string): string | null
    removeRejected(rejectedFile: string): boolean
  };
  /** 归档区本体，供断言直接看正文 */
  archived: Map<string, string>
  /** 回收站本体（plan56 片③） */
  rejected: Map<string, string>
}

export function createArchiveMock(opts: {
  files: Map<string, string>
  notesRoot: string
  archRoot: string
  /** 假后端自己的其它目录（如 candidates/）—— read 与 remove 在 notes、归档区都够不着时问它 */
  fallback?: (file: string) => string | null
  removeFallback?: (file: string) => boolean
  /** 候选目录（默认 `<notesRoot>/candidates`，与各文件自带假 backend 的口径一致） */
  candRoot?: string
  /** 回收站目录（默认与归档区同级的 `rejected`） */
  rejectedRoot?: string
}): ArchiveMock {
  const archived = new Map<string, string>()
  const rejected = new Map<string, string>()
  const { files, notesRoot, archRoot } = opts
  const candRoot = opts.candRoot ?? `${notesRoot}/candidates`
  const rejectedRoot = opts.rejectedRoot ?? `${archRoot.replace(/archived$/, 'rejected')}`
  return {
    archived,
    rejected,
    backend: {
      read: (file) => files.get(file) ?? archived.get(file) ?? opts.fallback?.(file) ?? null,
      remove: (file) => {
        if (archived.delete(file)) return true
        if (files.delete(file)) return true
        return opts.removeFallback?.(file) ?? false
      },
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
      rejected,
      reject: (file) => {
        if (!file.startsWith(`${candRoot}/`) || !file.endsWith('.md')) return null
        const text = files.get(file)
        if (text === undefined) return null
        const slug = file.slice(candRoot.length + 1, -3)
        const to = `${rejectedRoot}/${archivedFileName(slug, new Date(Date.now() + tick++))}`
        files.delete(file)
        rejected.set(to, text)
        return to
      },
      listRejected: () => [...rejected.keys()].sort(),
      // ⚠️ 只有这一个读口 —— `read` 故意不覆盖回收站，与真后端"回收站不在 insideMemory"同形
      readRejected: (rejectedFile) => rejected.get(rejectedFile) ?? null,
      restoreRejectedFrom: (rejectedFile) => {
        const parsed = parseArchivedFileName(rejectedFile.split('/').pop() ?? '')
        if (!parsed) return null
        const text = rejected.get(rejectedFile)
        if (text === undefined) return null
        const to = `${candRoot}/${parsed.slug}.md`
        if (files.has(to)) return null // 同名已在待批队列 ⇒ 绝不覆盖
        rejected.delete(rejectedFile)
        files.set(to, text)
        return to
      },
      removeRejected: (rejectedFile) => rejected.delete(rejectedFile),
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
