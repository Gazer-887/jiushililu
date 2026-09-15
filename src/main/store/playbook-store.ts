// Playbook 的**装配层**（plan19 批 3）：数据根 → fs 后端 → repo，跑一次幂等的格式迁移。
// ⚠️ 数据根**由组合根注入**，本文件既不解析路径也不碰 electron：
//    Playbook 层因此**物理上**没有通路能碰到 `store/settings.ts`（权限档的唯一真相源）——
//    与 `memory-store.ts` 同一条架构不变量，由 `architecture.test.ts` 的守卫乙看守。

import { createPlaybookRepo, type PlaybookRepo, type PlaybookRepoOptions } from '../memory/playbook-core'
import {
  createFsPlaybookBackend,
  migratePlaybookFormat,
  type FsPlaybookBackend
} from './playbook-fs'
import { nodeFsAdapter, type FsAdapter } from './conversations-fs'

export interface PlaybookStore extends PlaybookRepo {
  /** 供界面/门禁取磁盘状态（事件流、meta） */
  backend: FsPlaybookBackend
}

export function createPlaybookStore(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: PlaybookRepoOptions = {}
): PlaybookStore {
  const warn = opts.onWarn ?? (() => {})

  // 每次启动都跑一遍（幂等：已是新格式就立刻返回，代价是一次 existsSync）
  migratePlaybookFormat(root, fs, warn)
  const backend = createFsPlaybookBackend(root, fs, { onWarn: warn })
  const inner = createPlaybookRepo(backend, opts)

  return {
    ...inner,
    backend
  }
}
