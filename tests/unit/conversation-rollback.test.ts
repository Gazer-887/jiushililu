import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ConversationMeta } from '@shared/ipc'
import {
  createConversationsRepo,
  type ConversationsBackend
} from '@main/store/conversations-core'
import { createFsConversationsBackend } from '@main/store/conversations-fs'

// 会话回滚（plan10 B 批 · ④）：正文**只追加、从不裁剪**，`meta.messageCount` 充当**游标**（可见长度）。
// 于是回滚 = 移游标（**一条数据都不删**）、撤销回滚 = 游标移回末尾（零成本），
// 「保留策略（留几轮）」这个问题直接消失（不复制历史就没有膨胀）。
// 下面钉的是这套语义的每条边界，尤其是"**什么时候尾巴会作废**"—— 唯一一处会真丢东西的地方。

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-rb-'))
  roots.push(dir)
  return dir
}

/** 最小内存 backend：meta 与正文分开，正文就是那份"完整日志" */
function memBackend(meta: ConversationMeta, log: ChatMessage[]): {
  backend: ConversationsBackend
  log: () => ChatMessage[]
  writes: () => number
} {
  let m = meta
  let l = [...log]
  let writes = 0
  return {
    backend: {
      readMeta: () => ({ [m.id]: m }),
      putMeta: (_id, next) => {
        writes += 1
        m = next
      },
      removeMeta: () => {},
      readMessages: () => [...l],
      writeMessages: (_id, next) => {
        writes += 1
        l = [...next]
      },
      removeMessages: () => {}
    },
    log: () => [...l],
    writes: () => writes
  }
}

const u = (content: string): ChatMessage => ({ role: 'user', content })
const a = (content: string): ChatMessage => ({ role: 'assistant', content })

/** 四轮对话（8 条）：u0 a0 u1 a1 u2 a2 u3 a3 */
const eightTurns: ChatMessage[] = [
  u('问一'),
  a('答一'),
  u('问二'),
  a('答二'),
  u('问三'),
  a('答三'),
  u('问四'),
  a('答四')
]

const metaOf = (over: Partial<ConversationMeta> = {}): ConversationMeta => ({
  id: 'c',
  title: '会话',
  workspace: 'D:/ws',
  model: 'm',
  skills: [],
  createdAt: 1000,
  updatedAt: 1000,
  messageCount: 8,
  ...over
})

describe('rollbackConversation（回到某条之前）', () => {
  it('移到第 4 条之前：可见 4 条、**日志 8 条一条没少**、可撤销', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    const out = repo.rollbackConversation('c', 4)!

    expect(out.messages).toEqual(eightTurns.slice(0, 4))
    expect(out.meta.messageCount).toBe(4)
    expect(out.total).toBe(8)
    expect(out.canUndo).toBe(true)
    expect(m.log()).toHaveLength(8)
  })

  it('回滚之后的 `getConversation` 只给可见的那部分（尾巴不给界面）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 4)
    const conv = repo.getConversation('c')!
    expect(conv.messages).toHaveLength(4)
    expect(conv.messageCount).toBe(4) // 侧边栏显示的是可见条数
  })

  it('移到第 0 条之前 = 清空可见（日志仍在）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const out = createConversationsRepo(m.backend).rollbackConversation('c', 0)!
    expect(out.messages).toEqual([])
    expect(out.canUndo).toBe(true)
    expect(m.log()).toHaveLength(8)
  })

  it('**越界一律夹紧**（负数 → 0；超过长度 → 末尾），不让界面炸', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    expect(repo.rollbackConversation('c', -5)!.meta.messageCount).toBe(0)
    expect(repo.rollbackConversation('c', 999)!.meta.messageCount).toBe(8)
    expect(repo.rollbackConversation('c', 3.7)!.meta.messageCount).toBe(3) // 取整
  })

  it('id 不存在 → null（不抛）', () => {
    const m = memBackend(metaOf(), eightTurns)
    expect(createConversationsRepo(m.backend).rollbackConversation('nope', 2)).toBeNull()
  })
})

describe('undoRollback（撤销回滚）', () => {
  it('把尾巴接回来：又看得见 8 条，且**不删任何东西**', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 4)
    const out = repo.undoRollback('c')!

    expect(out.messages).toEqual(eightTurns)
    expect(out.meta.messageCount).toBe(8)
    expect(out.canUndo).toBe(false)
  })

  it('**没什么可撤销时不落盘**（免得为一次空操作写一遍盘）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    const before = m.writes()
    const out = repo.undoRollback('c')!
    expect(out.canUndo).toBe(false)
    expect(out.messages).toEqual(eightTurns)
    expect(m.writes()).toBe(before)
  })

  it('id 不存在 → null', () => {
    const m = memBackend(metaOf(), eightTurns)
    expect(createConversationsRepo(m.backend).undoRollback('nope')).toBeNull()
  })
})

describe('回滚之后继续说话：**尾巴何时作废**（唯一会真丢东西的地方）', () => {
  it('回滚后说了新话 → 旧尾巴**作废**（它属于另一条分支，留着只会排在错误的位置）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 4)

    const next = [...eightTurns.slice(0, 4), u('换个问法'), a('')]
    repo.saveConversation('c', next)

    expect(m.log()).toEqual(next) // 旧尾巴（问三/答三/问四/答四）已经不在了
    expect(m.log()).toHaveLength(6)
  })

  it('**流式原地生长不该被当成回滚**（末条允许不同，否则每吐一个字都算回滚）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 4)
    const visible = [...eightTurns.slice(0, 4), u('新问题'), a('')]
    repo.saveConversation('c', visible)

    repo.saveConversation('c', [...visible.slice(0, -1), a('前半段')])
    repo.saveConversation('c', [...visible.slice(0, -1), a('前半段后半段')])

    expect(m.log()).toHaveLength(6)
    expect(m.log()[5]!.content).toBe('前半段后半段')
    expect(repo.getConversation('c')!.messages).toHaveLength(6)
  })

  it('渲染端自己截断（不经回滚通道）→ 也当成回滚，尾巴照样留着可撤销', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.saveConversation('c', eightTurns.slice(0, 2)) // 直接交了一份更短的历史
    expect(repo.getConversation('c')!.messages).toHaveLength(2)
    expect(m.log()).toHaveLength(8) // 尾巴还在
    expect(repo.undoRollback('c')!.messages).toHaveLength(8) // 撤得回来
  })

  it('🐞 **回滚之后哪怕发生一次"原样保存"，尾巴也必须还在**（0.13.6 的真 bug）', () => {
    // 0.13.6 真 bug：回滚看着成功、点「撤销」却毫无反应 —— 根因是"等长"被划进了"追加"那一档，
    // 于是回滚后**任何一次保存**（切会话 / 点停止 / 关窗口都会触发）都把日志写成可见的那份，**尾巴当场被抹掉**。
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 4)
    const visible = repo.getConversation('c')!.messages

    repo.saveConversation('c', visible)

    expect(m.log()).toHaveLength(8) // ← 尾巴还在（修之前这里是 4）
    expect(repo.undoRollback('c')!.messages).toEqual(eightTurns) // 撤销仍然有效
  })

  it('原地更新时尾巴也留着（流式生长 ≠ 新分支）', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    repo.rollbackConversation('c', 6) // 尾巴 = 最后 2 条
    const visible = repo.getConversation('c')!.messages
    repo.saveConversation('c', [...visible.slice(0, -1), a('末条被改写了')])

    expect(m.log()).toHaveLength(8) // 尾巴没被动
    expect(m.log()[5]!.content).toBe('末条被改写了') // 可见部分被更新了
    expect(repo.undoRollback('c')!.messages).toHaveLength(8)
  })

  it('认不出前缀（将来的编辑功能等）→ **整份重写**，不猜', () => {
    const m = memBackend(metaOf(), eightTurns)
    const repo = createConversationsRepo(m.backend)
    const edited = [u('被改过的第一条'), ...eightTurns.slice(1)]
    repo.saveConversation('c', edited)
    expect(m.log()).toEqual(edited)
    expect(repo.getConversation('c')!.messages).toEqual(edited)
  })
})

describe('回滚走真磁盘（重启之后依然成立）', () => {
  it('回滚 → 重开后端 → 仍是回滚后的样子；撤销 → 全回来', () => {
    const root = tmpRoot()
    const seed = createConversationsRepo(createFsConversationsBackend(root))
    const c = seed.createConversation({
      workspace: 'D:/ws',
      model: 'm',
      skills: [],
      firstMessage: '问一'
    })
    seed.saveConversation(c.id, eightTurns)

    const repo = createConversationsRepo(createFsConversationsBackend(root))
    repo.rollbackConversation(c.id, 4)

    // **重启**（换一个后端实例）
    const reopened = createConversationsRepo(createFsConversationsBackend(root))
    expect(reopened.getConversation(c.id)!.messages).toHaveLength(4)
    expect(reopened.listConversations()[0]!.messageCount).toBe(4)

    reopened.undoRollback(c.id)
    const again = createConversationsRepo(createFsConversationsBackend(root))
    expect(again.getConversation(c.id)!.messages).toEqual(eightTurns)
  })
})
