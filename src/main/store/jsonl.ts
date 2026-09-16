import { basename, dirname, join } from 'node:path'
import { MAX_ARCHIVES, MAX_FILE_BYTES } from '../log'
import type { FsAdapter } from './conversations-fs'

/**
 * JSONL 追加 + 轮转的**共用小模块**（plan26 D-077）。
 *
 * 从 memory-fs.ts 提取（记忆事件流与执行事件流是同一件事的两个使用者：单文件上限、
 * 后移轮转、追加失败只告警不阻塞）—— 两处各拍一套数迟早分叉，轮转策略是一件事。
 * 上限与份数**共用 `log.ts` 的常量**（memory-fs 既有约定）。
 */

/** 轮转：超过单文件上限时后移（`x.1.jsonl ← x.jsonl` …），最旧的删掉。返回是否发生了轮转 */
export function rotateJsonlIfNeeded(
  currentPath: string,
  fs: FsAdapter,
  opts: { maxBytes?: number; maxArchives?: number } = {}
): boolean {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const maxArchives = opts.maxArchives ?? MAX_ARCHIVES
  // 档案与当前文件同目录、同名去扩展带序号：events.jsonl → events.1.jsonl
  const dir = dirname(currentPath)
  const name = basename(currentPath).replace(/\.jsonl$/, '')
  const archiveFor = (index: number) => join(dir, `${name}.${index}.jsonl`)
  if (fs.sizeBytes(currentPath) < maxBytes) return false
  const oldest = archiveFor(maxArchives)
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
  for (let i = maxArchives - 1; i >= 1; i--) {
    const from = archiveFor(i)
    if (fs.existsSync(from)) fs.renameSync(from, archiveFor(i + 1))
  }
  fs.renameSync(currentPath, archiveFor(1))
  return true
}

/** 追加一行 JSONL（调用方负责 stringify）。失败抛给上层 —— 由包装器决定「仅告警」还是「中断」 */
export function appendJsonlLine(path: string, line: string, fs: FsAdapter): void {
  fs.appendFileSync(path, line + '\n', 'utf8')
}
