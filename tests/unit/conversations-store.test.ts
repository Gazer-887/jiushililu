import { describe, expect, it } from 'vitest'
import {
  createConversationsRepo,
  type ConversationsBackend
} from '@main/store/conversations-core'
import type {
  ChatMessage,
  Conversation,
  ConversationCreateInput,
  ConversationMeta
} from '@shared/ipc'

// 会话存储六个入口的**行为基线**（plan10 步骤 0 立，A 批分层后**必须仍然全绿**）
//
// 为什么要先有这张网：A 批要给会话存储**分层**（正文从整表里搬出去），
// 而计划里原来写着"六个入口行为不变，**现有单测兜底**"——
// 审查实测发现那句话是空的：`tests/unit/conversations.test.ts` 只测了三个纯函数，
// **六个入口一条覆盖都没有**。没有网就重构，等于在没护栏的崖边换轮胎。
//
// A 批唯一允许改变的，是**读盘足迹**（列表不再碰正文）——
// 其余每一条语义都必须一模一样。下面每条都写清"为什么它必须如此"。

/** 内存 backend：meta 与正文分开存，并分别记账 —— "列表碰不碰正文"要能断言 */
function memBackend(seed: Record<string, Conversation> = {}): {
  backend: ConversationsBackend
  stats: {
    metaReads: number
    messageReads: number
    metaWrites: number
    messageWrites: number
    messageRemoves: number
  }
  dump: () => Record<string, Conversation>
} {
  const meta: Record<string, ConversationMeta> = {}
  const msgs: Record<string, ChatMessage[]> = {}
  for (const [id, c] of Object.entries(seed)) {
    const { messages, ...m } = c
    // ⚠️ 分层带来的**真实语义变化**：旧版 `messageCount` 是**读的时候现算**的
    //    （`toMeta` 展开 messages），所以它永远和正文一致；分层之后列表不读正文，
    //    于是 `messageCount` 必须**落在 meta 里**、由每次保存同步写好。
    //    这里造种子时也要按同一口径造 —— 不然就是在测一个现实中不存在的状态
    //    （第一版就是这么红的，测试帮我抓到了这次重构真正改了什么）。
    meta[id] = { ...m, messageCount: messages.length }
    msgs[id] = messages
  }
  const stats = {
    metaReads: 0,
    messageReads: 0,
    metaWrites: 0,
    messageWrites: 0,
    messageRemoves: 0
  }
  return {
    backend: {
      readMeta: () => {
        stats.metaReads += 1
        return { ...meta }
      },
      putMeta: (id, m) => {
        stats.metaWrites += 1
        meta[id] = m
      },
      removeMeta: (id) => {
        delete meta[id]
      },
      readMessages: (id) => {
        stats.messageReads += 1
        return msgs[id] ?? []
      },
      writeMessages: (id, list) => {
        stats.messageWrites += 1
        msgs[id] = list
      },
      removeMessages: (id) => {
        stats.messageRemoves += 1
        delete msgs[id]
      }
    },
    stats,
    dump: () => {
      const out: Record<string, Conversation> = {}
      for (const [id, m] of Object.entries(meta)) out[id] = { ...m, messages: msgs[id] ?? [] }
      return out
    }
  }
}

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: 't',
    workspace: 'D:/ws',
    model: 'm',
    skills: [],
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    messages: [],
    ...over
  }
}

function input(over: Partial<ConversationCreateInput> = {}): ConversationCreateInput {
  return { workspace: 'D:/ws', model: 'deepseek-flash', skills: [], ...over }
}

describe('createConversation（新建）', () => {
  it('生成 id、createdAt 与 updatedAt 相同、messageCount 与消息数一致', () => {
    const { backend, dump } = memBackend()
    const repo = createConversationsRepo(backend)
    const c = repo.createConversation(input({ firstMessage: '你好' }))

    expect(c.id).toMatch(/^[0-9a-f-]{36}$/) // UUID
    expect(c.createdAt).toBe(c.updatedAt)
    expect(c.messages).toEqual([{ role: 'user', content: '你好' }])
    expect(c.messageCount).toBe(1)
    expect(dump()[c.id]!.title).toBe('你好')
  })

  it('firstMessage 只有空白 → 不产生消息（标题回退默认），也**不写正文文件**', () => {
    const { backend, stats } = memBackend()
    const repo = createConversationsRepo(backend)
    const c = repo.createConversation(input({ firstMessage: '   \n ' }))
    expect(c.messages).toEqual([])
    expect(c.messageCount).toBe(0)
    expect(c.title).toBe('新对话')
    // 没有正文就一个字节都不该写
    expect(stats.messageWrites).toBe(0)
  })

  it('完全不传 firstMessage → 同样是空会话', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).createConversation(input()).messages).toEqual([])
  })

  it('首条消息**前后空白会被 trim**（存进去的不是带空白的原文）', () => {
    const { backend } = memBackend()
    const c = createConversationsRepo(backend).createConversation(input({ firstMessage: '  帮我写个脚本  ' }))
    expect(c.messages[0]!.content).toBe('帮我写个脚本')
  })

  it('标题由首条消息推导（去 Markdown 标记）', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).createConversation(input({ firstMessage: '## 帮我写个脚本' })).title).toBe('帮我写个脚本')
  })
})

describe('listConversations（列表）', () => {
  it('**只回 meta，正文一个字段都不出去**（侧边栏不该付正文的代价）', () => {
    const { backend } = memBackend({
      a: conv({ id: 'a', messages: [{ role: 'user', content: '很长的正文' }] })
    })
    const list = createConversationsRepo(backend).listConversations()

    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('messages')
    expect(list[0]!.messageCount).toBe(1)
  })

  it('空存储 → 空数组（不是 null、不抛）', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).listConversations()).toEqual([])
  })

  it('同一毫秒的时间戳下，顺序仍然**稳定**（两次调用结果一致）', () => {
    // 注：这里**不**钉"插入序"这种具体顺序 —— 分层后数据源从"整表单文件"变成
    // "一份份会话文件"，来源顺序**合法地**会变。真正要保住的性质是**确定性**：
    // 同样的数据、两次调用必须一样（渲染端只按 updatedAt 排序，同毫秒会退化成任意序）。
    const { backend } = memBackend({
      a: conv({ id: 'a', updatedAt: 500 }),
      b: conv({ id: 'b', updatedAt: 500 }),
      c: conv({ id: 'c', updatedAt: 500 })
    })
    const repo = createConversationsRepo(backend)
    const first = repo.listConversations().map((m) => m.id)
    const second = repo.listConversations().map((m) => m.id)
    expect(second).toEqual(first)
    expect([...first].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('getConversation（取一条）', () => {
  it('取到完整对象（**含正文** —— 这一条和列表相反）', () => {
    const { backend } = memBackend({
      a: conv({ id: 'a', messages: [{ role: 'user', content: '正文' }] })
    })
    const c = createConversationsRepo(backend).getConversation('a')
    expect(c?.messages).toEqual([{ role: 'user', content: '正文' }])
  })

  it('id 不存在 → null（不抛），且**不白读正文**', () => {
    const { backend, stats } = memBackend()
    expect(createConversationsRepo(backend).getConversation('nope')).toBeNull()
    expect(stats.messageReads).toBe(0)
  })
})

describe('saveConversation（保存正文）', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: '帮我看看这段代码' },
    { role: 'assistant', content: '好的' }
  ]

  it('保存到不存在的 id → **null 且不落盘**', () => {
    const { backend, stats, dump } = memBackend()
    const repo = createConversationsRepo(backend)
    expect(repo.saveConversation('nope', msgs)).toBeNull()
    expect(stats.metaWrites).toBe(0)
    expect(stats.messageWrites).toBe(0)
    expect(dump()).toEqual({})
  })

  it('正文被替换、messageCount 跟着走、updatedAt 前进、返回的是 **meta**', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a', updatedAt: 1000 }) })
    const repo = createConversationsRepo(backend)
    const meta = repo.saveConversation('a', msgs)

    expect(meta).not.toBeNull()
    expect(meta).not.toHaveProperty('messages')
    expect(meta!.messageCount).toBe(2)
    expect(meta!.updatedAt).toBeGreaterThan(1000)
    expect(dump()['a']!.messages).toEqual(msgs)
  })

  it('**标题还是默认「新对话」+ 有首条用户消息 → 自动补标题**', () => {
    const { backend } = memBackend({ a: conv({ id: 'a', title: '新对话' }) })
    expect(createConversationsRepo(backend).saveConversation('a', msgs)!.title).toBe('帮我看看这段代码')
  })

  it('**用户手动改过标题（≠「新对话」）→ 绝不被覆盖**（这条是那个 if 的真正语义）', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a', title: '我自己起的名字' }) })
    const repo = createConversationsRepo(backend)
    expect(repo.saveConversation('a', msgs)!.title).toBe('我自己起的名字')
    expect(dump()['a']!.title).toBe('我自己起的名字')
  })

  it('没有用户消息时也不补标题（补的依据是"首条 user"，不是"首条消息"）', () => {
    const { backend } = memBackend({ a: conv({ id: 'a', title: '新对话' }) })
    const onlyAssistant: ChatMessage[] = [{ role: 'assistant', content: '我先说' }]
    expect(createConversationsRepo(backend).saveConversation('a', onlyAssistant)!.title).toBe('新对话')
  })

  it('保存空正文也照样落盘（"清空一段对话"是合法动作，计数归零）', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a' }) })
    expect(createConversationsRepo(backend).saveConversation('a', [])!.messageCount).toBe(0)
    expect(dump()['a']!.messages).toEqual([])
  })

  it('**先写正文、后写索引**（崩在中间只会"索引偏旧"，不会"索引说有正文却没有"）', () => {
    const order: string[] = []
    const m = memBackend({ a: conv({ id: 'a' }) })
    const backend: ConversationsBackend = {
      ...m.backend,
      writeMessages: (id, list) => {
        order.push('messages')
        m.backend.writeMessages(id, list)
      },
      putMeta: (id, meta) => {
        order.push('meta')
        m.backend.putMeta(id, meta)
      }
    }
    createConversationsRepo(backend).saveConversation('a', [{ role: 'user', content: 'x' }])
    expect(order).toEqual(['messages', 'meta'])
  })

  it('崩在"正文已写、索引没写"之间 → 计数偏旧但**正文是对的**（这条顺序换来的就是这个）', () => {
    // 分层之后 `messageCount` 是**存**在索引里的，于是它理论上可能与正文不一致。
    // 这个顺序把不一致的**方向**固定住了：只会"索引偏旧"，永远不会"索引说有、正文没有"。
    // 而偏旧的计数会在**下一次保存**时自愈。
    const m = memBackend({ a: conv({ id: 'a' }) })
    const crashing: ConversationsBackend = {
      ...m.backend,
      putMeta: () => {
        throw new Error('索引写入时断电（注入）')
      }
    }
    const repo = createConversationsRepo(crashing)
    expect(() => repo.saveConversation('a', [{ role: 'user', content: 'x' }])).toThrow()

    // 正文写进去了
    expect(m.backend.readMessages('a')).toEqual([{ role: 'user', content: 'x' }])
    // 但索引还是旧的计数（0）—— 方向明确，且下次保存会修正
    expect(m.backend.readMeta()['a']!.messageCount).toBe(0)
  })
})

describe('renameConversation（重命名）', () => {
  it('id 不存在 → null', () => {
    const { backend, stats } = memBackend()
    expect(createConversationsRepo(backend).renameConversation('nope', 'x')).toBeNull()
    expect(stats.metaWrites).toBe(0)
  })

  it('trim + 截断到 60 字', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a' }) })
    const repo = createConversationsRepo(backend)
    expect(repo.renameConversation('a', '  名字  ')!.title).toBe('名字')
    expect(repo.renameConversation('a', '长'.repeat(100))!.title).toHaveLength(60)
    expect(dump()['a']!.title).toHaveLength(60)
  })

  it('**空白标题 = 没改**：原样回 meta，且**不落盘**（省一次无意义的写）', () => {
    const { backend, stats, dump } = memBackend({ a: conv({ id: 'a', title: '原名', updatedAt: 1000 }) })
    const meta = createConversationsRepo(backend).renameConversation('a', '   ')
    expect(meta!.title).toBe('原名')
    expect(meta!.updatedAt).toBe(1000) // 连 updatedAt 都不动
    expect(stats.metaWrites).toBe(0)
    expect(dump()['a']!.title).toBe('原名')
  })

  it('重命名**不碰正文**（改名是索引上的事）', () => {
    const { backend, stats } = memBackend({ a: conv({ id: 'a' }) })
    createConversationsRepo(backend).renameConversation('a', '新名')
    expect(stats.messageReads).toBe(0)
    expect(stats.messageWrites).toBe(0)
  })

  it('真的改名 → updatedAt 前进', () => {
    const { backend } = memBackend({ a: conv({ id: 'a', updatedAt: 1000 }) })
    expect(createConversationsRepo(backend).renameConversation('a', '新名')!.updatedAt).toBeGreaterThan(1000)
  })
})

describe('deleteConversation（删除）', () => {
  it('删掉指定的那条，**其余不动**', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a' }), b: conv({ id: 'b' }) })
    createConversationsRepo(backend).deleteConversation('a')
    expect(Object.keys(dump())).toEqual(['b'])
  })

  it('删除时要**连带删掉正文文件**（否则会留下永远不会被读到的孤儿）', () => {
    const { backend, stats } = memBackend({ a: conv({ id: 'a' }) })
    createConversationsRepo(backend).deleteConversation('a')
    expect(stats.messageRemoves).toBe(1)
  })

  it('id 不存在 → no-op，**不落盘**（免得为一次空删写盘）', () => {
    const { backend, stats } = memBackend({ a: conv({ id: 'a' }) })
    createConversationsRepo(backend).deleteConversation('nope')
    expect(stats.metaWrites).toBe(0)
    expect(stats.messageRemoves).toBe(0)
  })

  it('删掉之后 `getConversation` 返回 null（两处口径一致）', () => {
    const { backend } = memBackend({ a: conv({ id: 'a' }) })
    const repo = createConversationsRepo(backend)
    repo.deleteConversation('a')
    expect(repo.getConversation('a')).toBeNull()
  })
})

describe('knownWorkspaces（历史工作区白名单）', () => {
  it('**去重**（多会话共用同一工作区只出现一次）', () => {
    const { backend } = memBackend({
      a: conv({ id: 'a', workspace: 'D:/w1' }),
      b: conv({ id: 'b', workspace: 'D:/w1' }),
      c: conv({ id: 'c', workspace: 'D:/w2' })
    })
    expect(createConversationsRepo(backend).knownWorkspaces().sort()).toEqual(['D:/w1', 'D:/w2'])
  })

  it('空存储 → 空数组（这个值被当授权白名单用，绝不能回 null）', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).knownWorkspaces()).toEqual([])
  })
})

describe('读盘足迹：**分层唯一要换来的东西**', () => {
  // A 批的验收第一条就是这个。旧版"读列表"要先解析全部正文；分层之后
  // 列表与白名单**不许碰任何正文文件**。这条不是性能优化，是这次重构的**目的本身**。
  const seeded = {
    a: conv({ id: 'a', messages: [{ role: 'user', content: '正文' }] }),
    b: conv({ id: 'b', messages: [{ role: 'user', content: '正文' }] })
  }

  it('`listConversations` **一个正文文件都不读**（只读 meta）', () => {
    const m = memBackend(seeded)
    createConversationsRepo(m.backend).listConversations()
    expect(m.stats.metaReads).toBe(1)
    expect(m.stats.messageReads, '列表碰了正文文件').toBe(0)
  })

  it('`knownWorkspaces` 同样只读 meta', () => {
    const m = memBackend(seeded)
    createConversationsRepo(m.backend).knownWorkspaces()
    expect(m.stats.messageReads).toBe(0)
  })

  it('`getConversation` 只读**它自己那一条**正文（不是全部）', () => {
    const m = memBackend(seeded)
    createConversationsRepo(m.backend).getConversation('a')
    expect(m.stats.messageReads).toBe(1)
  })

  it('`saveConversation` 只写**它自己那一条**正文', () => {
    const m = memBackend(seeded)
    createConversationsRepo(m.backend).saveConversation('a', [{ role: 'user', content: '新' }])
    expect(m.stats.messageWrites).toBe(1)
    expect(m.stats.metaReads).toBe(1)
  })

  it('每个入口的 meta **最多读一遍**（不重复解析同一份索引）', () => {
    const cases: Array<[string, (r: ReturnType<typeof createConversationsRepo>) => void]> = [
      ['list', (r) => void r.listConversations()],
      ['get', (r) => void r.getConversation('a')],
      ['create', (r) => void r.createConversation(input())],
      ['save', (r) => void r.saveConversation('a', [{ role: 'user', content: 'x' }])],
      ['rename', (r) => void r.renameConversation('a', '新名')],
      ['delete', (r) => void r.deleteConversation('a')],
      ['knownWorkspaces', (r) => void r.knownWorkspaces()]
    ]
    for (const [name, run] of cases) {
      const m = memBackend(seeded)
      run(createConversationsRepo(m.backend))
      // 写的是"**最多**一遍"：`create` 压根不需要读索引（0 遍是对的，比读一遍更好），
      // 要抓的是**重复解析同一份索引**（旧实现每次保存读两遍全会话）。
      expect(m.stats.metaReads, `${name} 读了 ${m.stats.metaReads} 遍 meta`).toBeLessThanOrEqual(1)
    }
  })
})
