import { createHash } from 'node:crypto'
import { AgentPauseError } from './agent/pause-error'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** 内容版本与进程内提交队列；不声称能锁住外部编辑器的系统调用。 */
export const contentRevision = (content: Buffer | string): string =>
  createHash('sha256').update(content).digest('hex')

export function fileRevision(path: string): string | null {
  try { return contentRevision(readFileSync(path)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      const stat = statSync(path)
      return `directory:${stat.ino}:${stat.mtimeMs}`
    }
    throw error
  }
}

/** 只有 ENOENT 当"未建出来"；ENOTDIR 与权限/未知失败必须抛出（不用 existsSync，它对 EACCES 也返回 false）。 */
function existsStrict(abs: string): boolean {
  try {
    statSync(abs)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export function canonicalFilePath(path: string): string {
  let parent = resolve(path)
  const tail: string[] = []
  while (!existsStrict(parent)) {
    tail.unshift(basename(parent))
    const next = dirname(parent)
    if (next === parent) throw new Error('无法解析文件真实路径')
    parent = next
  }
  // 未存在的尾部必须挂在目录之下：普通文件之下不可能有子项
  if (tail.length > 0 && !statSync(parent).isDirectory()) throw new Error('无法解析文件真实路径：祖先不是目录')
  const key = join(realpathSync(parent), ...tail)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

const queues = new Map<string, Promise<unknown>>()
export async function withFileCommit<T>(paths: string[], commit: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(canonicalFilePath))].sort()
  const previous = keys.map((key) => queues.get(key) ?? Promise.resolve())
  let release!: () => void
  const lease = new Promise<void>((done) => { release = done })
  const tail = Promise.all(previous.map((p) => p.catch(() => {}))).then(() => lease)
  for (const key of keys) queues.set(key, tail)
  await Promise.all(previous.map((p) => p.catch(() => {})))
  try { return await commit() }
  finally {
    release()
    for (const key of keys) if (queues.get(key) === tail) queues.delete(key)
  }
}

export class FileConflictError extends AgentPauseError {
  constructor() { super('文件已变更，已暂停写入；请重新读取后再修改') }
}
