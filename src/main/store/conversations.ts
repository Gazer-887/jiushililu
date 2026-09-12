import Store from 'electron-store'
import type { Conversation } from '@shared/ipc'
import { createConversationsRepo } from './conversations-core'

// 会话持久化（P2 侧边栏）：一个「任务」= 一条会话，绑定一个工作区。
//
// **本文件只剩装配**：把 electron-store 接到"读一份 / 写一份"的接缝上。
// 六个入口的**行为全在 `conversations-core.ts`**（那边不 import electron，可单测）——
// 这是 `tests/unit/architecture.test.ts` 那条架构守卫要求的形状：
// 单测链路里不得出现 `electron` / `electron-store`（CI 是 Linux，没有 Electron 二进制）。
//
// 于是要测"新建会不会自动补标题""保存到不存在的 id 返回什么""重命名空标题落不落盘"，
// 都去 `tests/unit/conversations-store.test.ts` 用假 backend 测，**不需要起 Electron**。

interface ConversationStore {
  conversations?: Record<string, Conversation>
}

const store = new Store<ConversationStore>({ name: 'conversations' })

const repo = createConversationsRepo({
  read: () => store.store.conversations ?? {},
  // 写走 electron-store 的整表 set：它底下是**原子写**（临时文件 + rename），
  // 所以读者永远看不到"半截文件"。⚠️ plan10 分层时要保住这个性质：
  // checkpoints 那边的裸 writeFileSync 是另一种赌注（坏一个 manifest 只等于少一条记录），
  // 而会话正文是用户唯一的原始数据，不能照抄。
  //
  // 另：`all()` 的旧写法每次访问都重读+解析整个文件，`saveConversation` 里还被调了两次。
  // 现在读只发生在 `backend.read()`（一次），写只在这里。
  write: (next) => store.set('conversations', next)
})

export const {
  listConversations,
  getConversation,
  createConversation,
  saveConversation,
  renameConversation,
  deleteConversation,
  knownWorkspaces
} = repo
