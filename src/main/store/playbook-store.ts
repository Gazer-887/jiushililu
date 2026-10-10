// Playbook 的**装配层**（plan19 批 3）：数据根 → fs 后端 → repo，跑一次幂等的格式迁移。
// ⚠️ 数据根**由组合根注入**，本文件既不解析路径也不 import electron / settings。
//    守卫乙只检查 MEMORY_ROOTS 列出的纯逻辑入口（Playbook 的 playbook-core / playbook-inject）；
//    本装配层和 playbook-fs 不在入口清单内，因此不能称它们已受守卫乙验证。

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
