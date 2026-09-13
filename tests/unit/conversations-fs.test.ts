import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ConversationMeta } from '@shared/ipc'
import { createConversationsRepo } from '@main/store/conversations-core'
import {
  CONVERSATIONS_SCHEMA_VERSION,
  createFsConversationsBackend,
  messagesFilePath,
  metaFilePath,
  migrateConversationsFormat,
  nodeFsAdapter,
  type FsAdapter
} from '@main/store/conversations-fs'

// 分层磁盘后端（plan10 A 批）：布局 / 原子写 / **读盘足迹** / 格式迁移。
// 本批第一次动**磁盘格式**，重心不是"功能对不对"，而是三件硬事：
// ① 列表**不许碰任何正文文件**（字节级读盘足迹）② 格式迁移失败**不许留半迁移状态** ③ 换掉 electron-store 后它原先默默兜住的**原子写**还在不在

const roots: string[] = []

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-conv-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 记账版 fs：包住真实 fs —— 真文件、真字节，同时数得清"读了几个文件、读了多少字节" */
function countingFs(): { fs: FsAdapter; reads: string[]; bytes: () => number } {
  const reads: string[] = []
  let bytes = 0
  const fs: FsAdapter = {
    ...nodeFsAdapter,
    readFileSync: (path, enc) => {
      const data = nodeFsAdapter.readFileSync(path, enc)
      reads.push(path)
      bytes += Buffer.byteLength(data, 'utf8')
      return data
    }
  }
  return { fs, reads, bytes: () => bytes }
}

const meta = (id: string, over: Partial<ConversationMeta> = {}): ConversationMeta => ({
  id,
  title: `会话 ${id}`,
  workspace: 'D:/ws',
  model: 'deepseek-flash',
  skills: [],
  createdAt: 1000,
  updatedAt: 1000,
  messageCount: 0,
  ...over
})

const msg = (i: number): ChatMessage => ({ role: 'user', content: `第 ${i} 条消息` })

describe('布局：meta 与正文分开落盘', () => {
  it('meta 进 conversations.json（**不含 messages**），正文进 conversations/<id>.json', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    const repo = createConversationsRepo(backend)

    const c = repo.createConversation({
      workspace: 'D:/ws',
      model: 'm',
      skills: [],
      firstMessage: '你好'
    })

    const metaRaw = JSON.parse(readFileSync(metaFilePath(root), 'utf8')) as {
      schemaVersion: number
      conversations: Record<string, Record<string, unknown>>
    }
    expect(metaRaw.schemaVersion).toBe(CONVERSATIONS_SCHEMA_VERSION)
    expect(Object.keys(metaRaw.conversations)).toEqual([c.id])
    expect(metaRaw.conversations[c.id]).not.toHaveProperty('messages')
    expect(metaRaw.conversations[c.id]!.messageCount).toBe(1)

    const body = JSON.parse(readFileSync(messagesFilePath(root, c.id), 'utf8')) as ChatMessage[]
    expect(body).toEqual([{ role: 'user', content: '你好' }])
  })

  it('空会话**不写正文文件**（一个字节都不浪费）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })
    expect(existsSync(messagesFilePath(root, c.id))).toBe(false)
    expect(repo.getConversation(c.id)?.messages).toEqual([])
  })

  it('删除会**连带删掉正文文件**（不留孤儿）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [], firstMessage: 'x' })
    expect(existsSync(messagesFilePath(root, c.id))).toBe(true)
    repo.deleteConversation(c.id)
    expect(existsSync(messagesFilePath(root, c.id))).toBe(false)
    expect(repo.listConversations()).toEqual([])
  })

  it('往返一致：写入 → 重开后端 → 读出来一模一样', () => {
    const root = tmpRoot()
    const c = createConversationsRepo(createFsConversationsBackend(root)).createConversation({
      workspace: 'D:/ws',
      model: 'm',
      skills: ['a'],
      firstMessage: '你好'
    })
    // **重开**一个后端（模拟重启应用）
    const reopened = createConversationsRepo(createFsConversationsBackend(root))
    const back = reopened.getConversation(c.id)
    expect(back?.title).toBe('你好')
    expect(back?.messages).toEqual([{ role: 'user', content: '你好' }])
    expect(reopened.listConversations()[0]!.messageCount).toBe(1)
  })
})

describe('原子写：换掉 electron-store 之后必须守住的性质', () => {
  it('写完不留 .tmp 残骸（临时文件必须被 rename 掉）', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    backend.writeMessages('a', [msg(1)])
    backend.putMeta('a', meta('a', { messageCount: 1 }))

    const files = readdirSync(join(root, 'conversations'))
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(readdirSync(root).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('覆盖写：新内容整体替换旧的（不会新旧混在一起）', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    backend.writeMessages('a', [msg(1), msg(2), msg(3)])
    backend.writeMessages('a', [msg(9)])
    expect(backend.readMessages('a')).toEqual([msg(9)])
  })

  it('**正文读不出来时当空处理并留痕**，不许让整张表跟着挂', () => {
    const root = tmpRoot()
    const warns: string[] = []
    const backend = createFsConversationsBackend(root, nodeFsAdapter, {
      onWarn: (m) => warns.push(m)
    })
    backend.putMeta('good', meta('good'))
    backend.putMeta('bad', meta('bad'))
    // 手写一个坏掉的正文文件（`conversations/` 目录要先建出来 —— 空会话本来不建）
    mkdirSync(join(root, 'conversations'), { recursive: true })
    writeFileSync(messagesFilePath(root, 'bad'), '{ 这不是 JSON', 'utf8')

    expect(backend.readMessages('bad')).toEqual([])
    expect(warns.some((w) => w.includes('正文读不出来'))).toBe(true)
    // 关键：另一条会话照读不误
    expect(backend.readMessages('good')).toEqual([])
    expect(Object.keys(backend.readMeta()).sort()).toEqual(['bad', 'good'])
  })

  it('会话 id 不许带路径分隔符（防 `<id>.json` 往外跳）', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    expect(() => backend.writeMessages('../evil', [msg(1)])).toThrow(/不合法/)
    expect(backend.readMessages('../evil')).toEqual([])
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
  })

  it('**文件带 BOM 也读得出来**（JSON.parse 遇 BOM 会直接抛，表现为"会话全不见了"）', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    backend.putMeta('a', meta('a', { messageCount: 1 }))
    backend.writeMessages('a', [msg(1)])

    // 手动给两个文件都加上 BOM（用户手改 / 别的编辑器存过就会这样）
    for (const p of [metaFilePath(root), messagesFilePath(root, 'a')]) {
      const text = readFileSync(p, 'utf8')
      writeFileSync(p, `\uFEFF${text}`, 'utf8')
    }

    expect(Object.keys(backend.readMeta())).toEqual(['a'])
    expect(backend.readMessages('a')).toEqual([msg(1)])
  })
})

describe('读盘足迹：**分层唯一要换来的东西**', () => {
  // plan10 §六 第 1 条验收：列表不许展开任何正文。
  // ⚠️ 不用"读的字节 < 会话总量的 1/100"这类比例当判据 —— 它取决于"每条会话有多少消息"，消息越少比例越大，是拍脑袋的数；
  //    真正要证的是**列表代价不随正文增长**：正文翻倍，列表读的字节应当一个都不多（这比任何比例都硬）。
  it('**正文涨了 5 倍，列表读的字节一个都不多**（这才叫不随正文增长）', () => {
    const root = tmpRoot()
    const real = createFsConversationsBackend(root)
    const N = 60

    const seed = (perConv: number): void => {
      for (let i = 0; i < N; i += 1) {
        const id = `c${String(i).padStart(3, '0')}`
        const messages = Array.from({ length: perConv }, (_, k) => ({
          role: 'user' as const,
          content: `第 ${i} 号会话的第 ${k} 条消息，故意写长一点好让字节数拉开量级。`.repeat(4)
        }))
        real.writeMessages(id, messages)
        real.putMeta(id, meta(id, { messageCount: perConv }))
      }
    }

    // 两次用**同样位数**的条数（20 → 99），索引字节应当完全一致；位数一变（20 → 200）索引会因
    // `messageCount` 本身变长而多字符 —— 那不是跟着正文涨，别当成回归
    seed(20)
    const first = countingFs()
    createConversationsRepo(createFsConversationsBackend(root, first.fs)).listConversations()

    seed(99)
    const second = countingFs()
    const list = createConversationsRepo(createFsConversationsBackend(root, second.fs)).listConversations()

    expect(list).toHaveLength(N)
    expect(list.every((m) => m.messageCount === 99)).toBe(true)
    expect(second.bytes()).toBe(first.bytes())
    expect(second.reads).toEqual([metaFilePath(root)])
  })

  it('200 会话 × 50 消息：只读索引文件，且读的字节远小于正文总量', () => {
    const root = tmpRoot()
    const real = createFsConversationsBackend(root)
    const N = 200
    const M = 50
    let totalBytes = 0

    for (let i = 0; i < N; i += 1) {
      const id = `c${String(i).padStart(3, '0')}`
      const messages = Array.from({ length: M }, (_, k) => ({
        role: 'user' as const,
        content: `第 ${i} 号会话的第 ${k} 条消息，故意写长一点好让字节数拉开量级。`.repeat(4)
      }))
      real.writeMessages(id, messages)
      real.putMeta(id, meta(id, { messageCount: M }))
      totalBytes += Buffer.byteLength(JSON.stringify(messages, null, 2), 'utf8')
    }
    expect(totalBytes).toBeGreaterThan(200 * 1024) // 确认量级真的拉开了

    // 从这里开始记账
    const { fs, reads, bytes } = countingFs()
    const repo = createConversationsRepo(createFsConversationsBackend(root, fs))
    const list = repo.listConversations()

    // ① 访问过的文件**恰好只有**索引文件（这一条是定性的，不靠比例）
    expect(reads).toEqual([metaFilePath(root)])
    // ② 顺手一道粗门槛：抓"哪天把正文又并回索引去了"这种灾难级回退
    expect(bytes()).toBeLessThan(totalBytes / 20)
    // ③ 结果本身正确
    expect(list).toHaveLength(N)
    expect(list.every((m) => m.messageCount === M)).toBe(true)
    expect(list[0]).not.toHaveProperty('messages')
  })

  it('取一条只读**它自己**那一份正文（不是全部）', () => {
    const root = tmpRoot()
    const real = createFsConversationsBackend(root)
    for (const id of ['a', 'b', 'c']) {
      real.writeMessages(id, [msg(1)])
      real.putMeta(id, meta(id, { messageCount: 1 }))
    }
    const { fs, reads } = countingFs()
    createConversationsRepo(createFsConversationsBackend(root, fs)).getConversation('b')

    expect(reads).toEqual([metaFilePath(root), messagesFilePath(root, 'b')])
  })
})

describe('格式迁移 v1 → v2（**A 批唯一动用户数据的一步**）', () => {
  /** 按**真实**老格式造一份（字段与实测 `%APPDATA%\jiushililu\conversations.json` 一致） */
  function writeLegacy(root: string, conversations: Record<string, unknown>): void {
    writeFileSync(metaFilePath(root), JSON.stringify({ conversations }, null, '\t'), 'utf8')
  }

  const legacyConv = (id: string, messages: ChatMessage[]): Record<string, unknown> => ({
    id,
    title: `会话 ${id}`,
    workspace: 'D:/ws',
    model: 'deepseek-flash',
    skills: [],
    createdAt: 1000,
    updatedAt: 2000,
    messageCount: messages.length,
    messages
  })

  it('正文搬出整表，索引只留 meta，并且**先备份老文件**', () => {
    const root = tmpRoot()
    writeLegacy(root, {
      a: legacyConv('a', [msg(1), msg(2)]),
      b: legacyConv('b', [msg(3)])
    })
    const legacyText = readFileSync(metaFilePath(root), 'utf8')

    const res = migrateConversationsFormat(root, nodeFsAdapter, 'v1')
    expect(res.migrated).toBe(true)
    expect(res.moved).toBe(2)

    // 备份是**原样**的老文件（用户能据此找回）
    expect(res.backupPath).toBeTruthy()
    expect(readFileSync(res.backupPath!, 'utf8')).toBe(legacyText)

    // 索引：新版本号 + 没有正文
    const now = JSON.parse(readFileSync(metaFilePath(root), 'utf8')) as {
      schemaVersion: number
      conversations: Record<string, Record<string, unknown>>
    }
    expect(now.schemaVersion).toBe(CONVERSATIONS_SCHEMA_VERSION)
    expect(now.conversations['a']).not.toHaveProperty('messages')
    expect(now.conversations['a']!.messageCount).toBe(2)

    // 正文搬到了各自的文件
    expect(JSON.parse(readFileSync(messagesFilePath(root, 'a'), 'utf8'))).toEqual([msg(1), msg(2)])
    expect(JSON.parse(readFileSync(messagesFilePath(root, 'b'), 'utf8'))).toEqual([msg(3)])

    // 迁移完立刻可读（而且列表仍然只看索引）
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    expect(repo.listConversations().map((m) => m.messageCount).sort()).toEqual([1, 2])
    expect(repo.getConversation('a')?.messages).toEqual([msg(1), msg(2)])
  })

  it('**幂等**：跑第二遍直接说"已是新格式"，且文件内容一个字不变', () => {
    const root = tmpRoot()
    writeLegacy(root, { a: legacyConv('a', [msg(1)]) })
    expect(migrateConversationsFormat(root, nodeFsAdapter, 'v1').migrated).toBe(true)
    const after = readFileSync(metaFilePath(root), 'utf8')

    const second = migrateConversationsFormat(root, nodeFsAdapter, 'v1')
    expect(second.migrated).toBe(false)
    expect(second.reason).toBe('已是新格式')
    expect(readFileSync(metaFilePath(root), 'utf8')).toBe(after)
  })

  it('没有会话文件 → 什么都不做（新装用户第一次启动就是这条路）', () => {
    const root = tmpRoot()
    const res = migrateConversationsFormat(root, nodeFsAdapter, 'v1')
    expect(res.migrated).toBe(false)
    expect(res.reason).toBe('没有会话文件')
  })

  it('**失败时绝不覆盖索引**（半迁移是最糟的状态，宁可不迁）', () => {
    const root = tmpRoot()
    writeLegacy(root, { a: legacyConv('a', [msg(1)]) })
    const before = readFileSync(metaFilePath(root), 'utf8')

    // 注入一个"写正文就炸"的 fs。⚠️ 判据必须是 `<root>/conversations/` **目录下**的路径 ——
    // 原子写先落 `.tmp`，只按 `.json` 结尾去判会**判不到**；索引文件本就不该被拦，不在 must-throw 内。
    const convDir = join(root, 'conversations') + sep
    const failing: FsAdapter = {
      ...nodeFsAdapter,
      writeFileSync: (path, data, enc) => {
        if (path.startsWith(convDir)) throw new Error('磁盘满了（注入）')
        nodeFsAdapter.writeFileSync(path, data, enc)
      }
    }
    const warns: string[] = []
    const res = migrateConversationsFormat(root, failing, 'v1', (m) => warns.push(m))

    expect(res.migrated).toBe(false)
    expect(res.reason).toContain('磁盘满了')
    // 索引**原样未动**（还是老格式，正文还在里面）
    expect(readFileSync(metaFilePath(root), 'utf8')).toBe(before)
    expect(warns.some((w) => w.includes('已保留老文件'))).toBe(true)
  })

  it('**降级模式**：迁移没成功也能读（老格式里的正文被剥出来当兜底计数）', () => {
    const root = tmpRoot()
    writeLegacy(root, { a: legacyConv('a', [msg(1), msg(2)]) })
    // 故意不迁移，直接读
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const list = repo.listConversations()
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('messages')
    expect(list[0]!.messageCount).toBe(2) // ← 用老格式内嵌正文的长度兜底
  })
})

// 用量账本（plan8 R9 / R9.1）：它跟会话一起落盘，所以判据都在这儿。
// 账本写进**会话索引**而不是另开文件 —— 界面上那块牌写的是"本会话累计"，必须与这条会话同生共死；
// 另开文件迟早会出现"会话没了账还在"。
describe('用量账本：落盘 / 只长不缩 / 缺字段', () => {
  it('给了用量 → 写进 meta；重开一遍还能读到（不是只在内存里亮一下）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })

    repo.saveConversation(c.id, [msg(1)], { usage: { promptTokens: 1200, completionTokens: 340 } })

    // 换一个全新的 backend 实例再读 —— 验的才是"真落盘了"
    const reopened = createConversationsRepo(createFsConversationsBackend(root))
    expect(reopened.getConversation(c.id)?.usage).toEqual({ promptTokens: 1200, completionTokens: 340 })
    // 列表（只读 meta）里也带着 —— 界面不用打开会话就能显示账本
    expect(reopened.listConversations()[0]?.usage).toEqual({ promptTokens: 1200, completionTokens: 340 })
  })

  it('**不给用量 → 保持原值**（回滚/改名这类保存不许把账抹掉）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })
    repo.saveConversation(c.id, [msg(1)], { usage: { promptTokens: 100, completionTokens: 50 } })

    // 不带第三个参数的保存（老调用点就是这么调的）
    repo.saveConversation(c.id, [msg(1), msg(2)])

    expect(repo.getConversation(c.id)?.usage).toEqual({ promptTokens: 100, completionTokens: 50 })
  })

  it('**只长不缩**：晚到的旧快照不许把账写回去（数字倒退比不显示更费解）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })
    repo.saveConversation(c.id, [msg(1)], { usage: { promptTokens: 900, completionTokens: 300 } })

    // 一条"过期的"落盘请求（比如后台会话的防抖落盘晚到了一步）
    repo.saveConversation(c.id, [msg(1), msg(2)], { usage: { promptTokens: 100, completionTokens: 20 } })

    expect(repo.getConversation(c.id)?.usage).toEqual({ promptTokens: 900, completionTokens: 300 })
  })

  it('**省下的量**（plan8 R9.1）与厂商用量**分开存、分开长**', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })

    repo.saveConversation(c.id, [msg(1)], { avoidedTokens: 8200 })
    // 再存一次只带用量、不带 avoided → **不许把省下的量抹掉**（两个字段各自独立）
    repo.saveConversation(c.id, [msg(1), msg(2)], { usage: { promptTokens: 10, completionTokens: 5 } })

    const reopened = createConversationsRepo(createFsConversationsBackend(root))
    const got = reopened.getConversation(c.id)
    expect(got?.avoidedTokens).toBe(8200)
    expect(got?.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it('省下的量同样**只长不缩**（倒退的账看着像丢了）', () => {
    const root = tmpRoot()
    const repo = createConversationsRepo(createFsConversationsBackend(root))
    const c = repo.createConversation({ workspace: 'D:/ws', model: 'm', skills: [] })
    repo.saveConversation(c.id, [msg(1)], { avoidedTokens: 5000 })
    repo.saveConversation(c.id, [msg(1), msg(2)], { avoidedTokens: 120 })
    expect(repo.getConversation(c.id)?.avoidedTokens).toBe(5000)
  })

  it('老数据没有 usage / avoidedTokens 字段 → 读出来是 undefined（界面据此显示"暂无"，**不许补 0**）', () => {
    const root = tmpRoot()
    const backend = createFsConversationsBackend(root)
    backend.putMeta('a', meta('a'))
    const repo = createConversationsRepo(backend)
    expect(repo.getConversation('a')?.usage).toBeUndefined()
    expect(repo.getConversation('a')?.avoidedTokens).toBeUndefined()
  })
})
