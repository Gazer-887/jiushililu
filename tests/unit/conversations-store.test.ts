import { describe, expect, it } from 'vitest'
import {
  createConversationsRepo,
  type ConversationsBackend
} from '@main/store/conversations-core'
import type { ChatMessage, Conversation, ConversationCreateInput } from '@shared/ipc'

// 会话存储六个入口的**行为基线**（plan10 步骤 0）
//
// 为什么要先有这张网：A 批要给会话存储**分层**（正文从整表单文件里搬出去），
// 而计划里原来写着"六个入口行为不变，**现有单测兜底**"——
// 审查实测发现那句话是空的：`tests/unit/conversations.test.ts` 只测了三个纯函数，
// **六个入口一条覆盖都没有**。没有网就重构，等于在没护栏的崖边换轮胎。
//
// 为什么能用假 backend 测：`tests/unit/architecture.test.ts` 的架构守卫要求
// 单测链路里不得出现 `electron` / `electron-store`（CI 是 Linux，没有 Electron 二进制）。
// 而六个入口的**可验证行为**（标题规则 / 计数 / 去重 / 返回值 / 落不落盘）**与"谁来存"无关** ——
// 于是把读写抽成接缝（`ConversationsBackend`），逻辑在 `conversations-core.ts` 里测。
//
// ⚠️ 这张网锁的是**当前行为**（characterization），不是"我以为的行为"。
//    所以每条都写清"为什么它必须如此"，而不只是抄一遍代码。

/** 内存 backend：顺便数读写次数 —— "每个入口只读一遍"这条性质也要钉住 */
function memBackend(seed: Record<string, Conversation> = {}): {
  backend: ConversationsBackend
  stats: { reads: number; writes: number }
  dump: () => Record<string, Conversation>
  reset: () => void
} {
  let data: Record<string, Conversation> = { ...seed }
  const stats = { reads: 0, writes: 0 }
  return {
    backend: {
      read: () => {
        stats.reads += 1
        return data
      },
      write: (next) => {
        stats.writes += 1
        data = next
      }
    },
    stats,
    dump: () => data,
    reset: () => {
      stats.reads = 0
      stats.writes = 0
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
    // 落盘了，而且落的就是它
    expect(dump()[c.id]!.title).toBe('你好')
  })

  it('firstMessage 只有空白 → 不产生消息（标题回退默认）', () => {
    const { backend } = memBackend()
    const repo = createConversationsRepo(backend)
    const c = repo.createConversation(input({ firstMessage: '   \n ' }))
    expect(c.messages).toEqual([])
    expect(c.messageCount).toBe(0)
    expect(c.title).toBe('新对话')
  })

  it('完全不传 firstMessage → 同样是空会话', () => {
    const { backend } = memBackend()
    const repo = createConversationsRepo(backend)
    const c = repo.createConversation(input())
    expect(c.messages).toEqual([])
  })

  it('首条消息**前后空白会被 trim**（存进去的不是带空白的原文）', () => {
    const { backend } = memBackend()
    const repo = createConversationsRepo(backend)
    const c = repo.createConversation(input({ firstMessage: '  帮我写个脚本  ' }))
    expect(c.messages[0]!.content).toBe('帮我写个脚本')
  })

  it('标题由首条消息推导（去 Markdown 标记）', () => {
    const { backend } = memBackend()
    const repo = createConversationsRepo(backend)
    expect(repo.createConversation(input({ firstMessage: '## 帮我写个脚本' })).title).toBe('帮我写个脚本')
  })
})

describe('listConversations（列表）', () => {
  it('**只回 meta，正文一个字段都不出去**（侧边栏不该付正文的代价）', () => {
    const { backend } = memBackend({
      a: conv({ id: 'a', messages: [{ role: 'user', content: '很长的正文' }] })
    })
    const repo = createConversationsRepo(backend)
    const list = repo.listConversations()

    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('messages')
    // messageCount 是"算出来的"，不是从存储里读的 —— 它与正文永远一致
    expect(list[0]!.messageCount).toBe(1)
  })

  it('空存储 → 空数组（不是 null、不抛）', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).listConversations()).toEqual([])
  })

  it('同一毫秒的时间戳下，顺序仍然**稳定**（两次调用结果一致）', () => {
    // 注：这里**不**钉"插入序"这种具体顺序 —— A 批分层后数据源会从"整表单文件"
    // 变成"一份份会话文件"，来源顺序**合法地**会变。真正要保住的性质是**确定性**：
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

  it('id 不存在 → null（不抛）', () => {
    const { backend } = memBackend()
    expect(createConversationsRepo(backend).getConversation('nope')).toBeNull()
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
    expect(stats.writes).toBe(0)
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
    const repo = createConversationsRepo(backend)
    expect(repo.saveConversation('a', msgs)!.title).toBe('帮我看看这段代码')
  })

  it('**用户手动改过标题（≠「新对话」）→ 绝不被覆盖**（这条是那个 if 的真正语义）', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a', title: '我自己起的名字' }) })
    const repo = createConversationsRepo(backend)
    expect(repo.saveConversation('a', msgs)!.title).toBe('我自己起的名字')
    expect(dump()['a']!.title).toBe('我自己起的名字')
  })

  it('没有用户消息时也不补标题（补的依据是"首条 user"，不是"首条消息"）', () => {
    const { backend } = memBackend({ a: conv({ id: 'a', title: '新对话' }) })
    const repo = createConversationsRepo(backend)
    const onlyAssistant: ChatMessage[] = [{ role: 'assistant', content: '我先说' }]
    expect(repo.saveConversation('a', onlyAssistant)!.title).toBe('新对话')
  })

  it('保存空正文也照样落盘（"清空一段对话"是合法动作，计数归零）', () => {
    const { backend, dump } = memBackend({ a: conv({ id: 'a' }) })
    const repo = createConversationsRepo(backend)
    expect(repo.saveConversation('a', [])!.messageCount).toBe(0)
    expect(dump()['a']!.messages).toEqual([])
  })
})

describe('renameConversation（重命名）', () => {
  it('id 不存在 → null', () => {
    const { backend, stats } = memBackend()
    expect(createConversationsRepo(backend).renameConversation('nope', 'x')).toBeNull()
    expect(stats.writes).toBe(0)
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
    const repo = createConversationsRepo(backend)
    const meta = repo.renameConversation('a', '   ')
    expect(meta!.title).toBe('原名')
    expect(meta!.updatedAt).toBe(1000) // 连 updatedAt 都不动
    expect(stats.writes).toBe(0)
    expect(dump()['a']!.title).toBe('原名')
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

  it('id 不存在 → no-op，**不落盘**（免得为一次空删写盘）', () => {
    const { backend, stats } = memBackend({ a: conv({ id: 'a' }) })
    createConversationsRepo(backend).deleteConversation('nope')
    expect(stats.writes).toBe(0)
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

describe('读盘足迹：**每个入口只读一遍**', () => {
  // 这条是 A 批"分层"的先行指标：
  // 旧实现里 `saveConversation` 调了两次 `all()`，而 electron-store 每次访问 `store.store`
  // 都会 `readFileSync + JSON.parse` 整个文件（`conf/dist/source/index.js:276`）——
  // 也就是**每次保存读两遍全会话**。分层要消灭的就是这类 O(全量) 代价，
  // 所以"读几遍"必须现在就被钉住，否则改完没法证明它变好了。
  const seeded = { a: conv({ id: 'a' }) }

  it('六个入口各只读一遍', () => {
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
      expect(m.stats.reads, `${name} 读了 ${m.stats.reads} 遍`).toBe(1)
    }
  })

  it('一次保存最多落一次盘', () => {
    const m = memBackend(seeded)
    createConversationsRepo(m.backend).saveConversation('a', [{ role: 'user', content: 'x' }])
    expect(m.stats.writes).toBe(1)
  })
})
