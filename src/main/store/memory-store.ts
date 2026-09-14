// 记忆的**装配层**（plan19 §0.3 条 5 / §3.3）：数据根 → fs 后端 → repo，跑一次幂等的格式迁移。
// ⚠️ 数据根**由组合根注入**，本文件既不解析路径也不碰 electron：
//    记忆层因此**物理上**没有通路能碰到 `store/settings.ts`（权限档的唯一真相源）——
//    这是"记忆改不了权限"那条架构不变量在代码上的落点，由 `architecture.test.ts` 的守卫乙看守。

import { createMemoryRepo, type MemoryRepo, type MemoryRepoOptions } from '../memory/memory-core'
import { nodeFsAdapter, type FsAdapter } from './conversations-fs'
import {
  createFsMemoryBackend,
  migrateMemoryFormat,
  type FsMemoryBackend
} from './memory-fs'

export interface MemoryStore extends MemoryRepo {
  /** 供批 2 的反思队列与告知标记使用（批 1 只保证它存在且持久） */
  backend: FsMemoryBackend
  /**
   * 开一轮采集（护栏 2，D-043）。组合根在一轮对话前调它，轮末 `drainTurn()` 取走上报载荷 ——
   * 采集状态住在这里而不是组合根，是为了让"忘了采集"最多丢**痕迹**，绝不丢**落盘**。
   */
  beginTurn(): void
  drainTurn(): { written: string[]; rejected: { name: string; reason: string }[] }
}

export function createMemoryStore(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: MemoryRepoOptions = {}
): MemoryStore {
  const warn = opts.onWarn ?? (() => {})
  let collecting: { written: string[]; rejected: { name: string; reason: string }[] } | null = null

  // 每次启动都跑一遍（幂等：已是新格式就立刻返回，代价是一次 existsSync + 一次 JSON.parse）
  migrateMemoryFormat(root, fs, warn)
  const backend = createFsMemoryBackend(root, fs, { onWarn: warn })
  const inner = createMemoryRepo(backend, {
    ...opts,
    onWrite: (info) => {
      if (collecting) {
        if (info.ok) collecting.written.push(info.name)
        else collecting.rejected.push({ name: info.name, reason: info.reason ?? '未说明' })
      }
      opts.onWrite?.(info)
    }
  })

  return {
    ...inner,
    backend,
    beginTurn: () => {
      collecting = { written: [], rejected: [] }
    },
    drainTurn: () => {
      const out = collecting ?? { written: [], rejected: [] }
      collecting = null
      return out
    }
  }
}
