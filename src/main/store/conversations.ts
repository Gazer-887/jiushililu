import { app } from 'electron'
import type { ConversationsRepo } from './conversations-core'
import { createConversationsRepo } from './conversations-core'
import {
  createFsConversationsBackend,
  migrateConversationsFormat,
  nodeFsAdapter
} from './conversations-fs'
import { createLogger } from '../log'

// 会话持久化（P2 侧边栏）：一个「任务」= 一条会话，绑定一个工作区。
//
// **本文件只剩装配**：解析数据目录 → 跑一次格式迁移 → 把磁盘后端接到逻辑层。
// 六个入口的**行为全在 `conversations-core.ts`**（那边不依赖 electron / fs，可单测）；
// 分层布局与原子写在 `conversations-fs.ts`（fs 可注入，所以"读盘足迹"也能单测）。
//
// ## 为什么这里不再用 electron-store
//
// 旧版用 `new Store({ name: 'conversations' })` 存"整表 + 正文内嵌"。换掉它有两条理由：
//   1. **要分层**：正文必须搬出整表，而 electron-store 只支持"整个对象一把写"
//   2. **要可测**：`electron-store` 在**构造函数里**就锁死 `app.getPath('userData')`，
//      于是它只能出现在装配层、永远进不了单测链路（架构守卫也禁止）。自己写 fs 之后，
//      "列表到底读了几个文件、读了多少字节"变成**可断言**的事 —— 而这正是 A 批的验收口径。
// 它原先顺带帮我们兜住的**原子写**没有丢：`conversations-fs.ts` 里显式实现（临时文件 + rename）
// 并有测试钉着。⚠️ 这一点必须显式守住 —— 见该文件顶部第 1 条约束。
//
// ## 数据目录**惰性解析**
//
// 不在这里写 `const dir = app.getPath('userData')`：那会在**模块求值期**执行，
// 而模块求值早于 `app.whenReady()`。惰性解析 = 第一次真正用到时才取路径，
// 顺带从根上躲开 plan10 §2.4 P0-6 那个"'setPath' 晚于 store 构造、迁移成功却读写旧目录"的时序坑。

const log = createLogger('conversations')

let cached: ConversationsRepo | null = null

function dataRoot(): string {
  return app.getPath('userData')
}

function repo(): ConversationsRepo {
  if (cached) return cached
  const root = dataRoot()

  // 每次启动都跑一遍迁移检查（幂等：已是新格式就立刻返回，代价是一次 existsSync + 一次 JSON.parse）
  const migration = migrateConversationsFormat(root, nodeFsAdapter, 'v1', (message, extra) =>
    log.warn(message, extra)
  )
  if (migration.migrated) {
    log.info('会话存储已分层（正文搬出整表）', {
      moved: migration.moved,
      backup: migration.backupPath
    })
  } else if (migration.reason && migration.reason !== '已是新格式' && migration.reason !== '没有会话文件') {
    // 失败**不阻断启动**：老文件原样留着，后端会以降级模式读它
    log.error('会话格式迁移未完成', { reason: migration.reason })
  }

  cached = createConversationsRepo(
    createFsConversationsBackend(root, nodeFsAdapter, {
      onWarn: (message, extra) => log.warn(message, extra)
    })
  )
  return cached
}

export function listConversations() {
  return repo().listConversations()
}

export function getConversation(id: string) {
  return repo().getConversation(id)
}

export function createConversation(input: Parameters<ConversationsRepo['createConversation']>[0]) {
  return repo().createConversation(input)
}

export function saveConversation(
  id: string,
  messages: Parameters<ConversationsRepo['saveConversation']>[1],
  stats?: Parameters<ConversationsRepo['saveConversation']>[2]
) {
  return repo().saveConversation(id, messages, stats)
}

export function renameConversation(id: string, title: string) {
  return repo().renameConversation(id, title)
}

export function deleteConversation(id: string) {
  return repo().deleteConversation(id)
}

/** **回到第 `toIndex` 条消息之前**（plan10 B 批 ④）—— 只移游标、不删数据 */
export function rollbackConversation(id: string, toIndex: number) {
  return repo().rollbackConversation(id, toIndex)
}

/** 撤销上一次回滚（尾巴一直在盘上，所以这是零成本的） */
export function undoRollback(id: string) {
  return repo().undoRollback(id)
}

/** 历史会话用过的工作区路径集合——用于收紧 workspace:set-known 的权限面 */
export function knownWorkspaces() {
  return repo().knownWorkspaces()
}
