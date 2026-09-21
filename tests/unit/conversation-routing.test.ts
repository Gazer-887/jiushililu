import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc'

/**
 * **串台回归门 + 落盘归属门**（plan11 §四 步骤 1）—— 针对的都是**现存缺陷**，不是新功能：
 *   ① **切会话串台**：A 正在吐字时你切到 B，后面的字会落进 B；
 *   ② **后台会话整轮丢**：`markDone()` 只落"当前显示的那条"，在后台跑完的那条**没人替它落盘**。
 * 所以它们在**旧代码上必须是红的**（绿就是写错了）；判据盯**结果**（落到哪条会话、用哪个 id），不盯实现。
 */

/** 假桥：只实现被测路径用到的那几个方法 */
const saved: { id: string; messages: ChatMessage[] }[] = []
const fakeApi = {
  saveConversation: vi.fn(async (id: string, messages: ChatMessage[]) => {
    saved.push({ id, messages: structuredClone(messages) })
    return null // 不更新列表，避免把这条路径之外的逻辑牵进来
  }),
  chatSend: vi.fn(async () => undefined),
  chatAbort: vi.fn(async () => undefined),
  // 下面三个是 `newSession` / `createConversation` 这条路上要碰的桥（K9 复查补）
  switchConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => ({ id: 'C', title: '新会话', messages: [] })),
  deleteConversation: vi.fn(async () => undefined),
  listConversations: vi.fn(async () => [])
}
vi.stubGlobal('window', { api: fakeApi })

// eslint-disable-next-line import/first -- 必须先立好 window 假桥（store 不在模块加载期碰 window，但顺序写对更稳）
import { useAppStore } from '../../src/renderer/src/store'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const A_MSGS: ChatMessage[] = [
  { role: 'user', content: 'A 的问题' },
  { role: 'assistant', content: 'A 的回答' }
]

/** B 是**后台那条**：它的现场存在存档里（真实路径里由 `sendMessage` 种下） */
const bSnapshot = {
  messages: [
    { role: 'user' as const, content: 'B 的问题' },
    { role: 'assistant' as const, content: 'B 答了一半' }
  ],
  streaming: true,
  streamError: null,
  reasoning: '',
  toolEvents: [],
  todos: [],
  subagents: []
}

describe('会话路由：片段只能落进它自己那条会话', () => {
  beforeEach(() => {
    saved.length = 0
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: { B: structuredClone(bSnapshot) }
    })
  })

  it('🐞 **后台会话的片段不许落进当前显示的会话**（切会话串台）', () => {
    useAppStore.getState().appendChunk({ conversationId: 'B', payload: 'B 的字' })

    // 当前显示的 A **一个字都不该变**（旧代码会把 'B 的字' 接到 A 的回答后面）
    expect(useAppStore.getState().messages).toEqual(A_MSGS)
  })

  it('阳性对照：当前会话自己的片段照常接上（别为了防串台把正常路径也掐了）', () => {
    useAppStore.getState().appendChunk({ conversationId: 'A', payload: '，接着说' })
    const msgs = useAppStore.getState().messages
    expect(msgs[msgs.length - 1].content).toBe('A 的回答，接着说')
  })

  it('🐞 **后台会话跑完 → 落盘的是那一条**（不是当前显示的那条）', async () => {
    useAppStore.getState().markDone({ conversationId: 'B', payload: null })
    await flush()

    expect(saved, '后台会话跑完必须有人替它落盘 —— 否则整轮白跑').toHaveLength(1)
    expect(saved[0].id, '落盘用错 id 就等于把 B 的内容盖到 A 上').toBe('B')
    // 内容也必须是 B 的（拿当前会话的内容去存 B 同样是把数据搞坏）
    expect(saved[0].messages.map((m) => m.content)).toEqual(['B 的问题', 'B 答了一半'])
  })

  it('阳性对照：当前会话跑完照常落盘（用当前会话的 id 与内容）', async () => {
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe('A')
    expect(saved[0].messages.map((m) => m.content)).toEqual(['A 的问题', 'A 的回答'])
    expect(fakeApi.saveConversation).toHaveBeenCalled()
  })

  it('🐞 后台会话报错也要落盘（错到一半的内容也是内容）', async () => {
    useAppStore.getState().markError({ conversationId: 'B', payload: '中断了' })
    await flush()
    expect(saved.map((s) => s.id)).toEqual(['B'])
  })

  it('后台会话的片段追加进**它的存档**，不碰当前会话', () => {
    useAppStore.getState().appendChunk({ conversationId: 'B', payload: '，接着说' })
    const b = useAppStore.getState().runtimes['B']
    expect(b.messages[b.messages.length - 1].content).toBe('B 答了一半，接着说')
    expect(useAppStore.getState().messages).toEqual(A_MSGS)
  })

  it('存档里没有的会话：事件被丢弃并告警，**绝不凭空造一份空的**（那样下次落盘会把真内容覆盖成空）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAppStore.getState().appendChunk({ conversationId: '不存在的会话', payload: 'x' })
    expect(useAppStore.getState().runtimes['不存在的会话']).toBeUndefined()
    expect(useAppStore.getState().messages).toEqual(A_MSGS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// K8 排查时被埋掉的那半句：主进程 `friendlyParse` 抛的是
// 「参数不合法：messages.3.content —— 空正文只允许出现在助手轮」，而渲染层旧 catch 把它换成
// 一句通用的「请求被主进程拒绝（参数校验未通过）」—— 唯一能定位"是哪条消息坏了"的线索当场没了。
describe('发送被主进程拒掉时，原文必须送达界面', () => {
  beforeEach(() => {
    saved.length = 0
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: false,
      streamError: null,
      saveError: null,
      runtimes: {}
    })
  })

  it('chatSend 抛出的 message 原样出现在 streamError 里', async () => {
    fakeApi.chatSend.mockRejectedValueOnce(
      new Error('参数不合法：messages.3.content —— 空正文只允许出现在助手轮')
    )
    await useAppStore.getState().sendMessage('再问一句')
    const err = useAppStore.getState().streamError ?? ''
    expect(err).toContain('messages.3.content')
    expect(err).toContain('空正文只允许出现在助手轮')
  })

  it('阳性对照：没有原文可给时也不能给空白（退回异常字符串）', async () => {
    fakeApi.chatSend.mockRejectedValueOnce('参数不合法：conversationId —— 不能为空')
    await useAppStore.getState().sendMessage('再问一句')
    expect(useAppStore.getState().streamError).toContain('conversationId')
  })
})

// K9：发送时 `archiveCurrent()` 给**当前这条会话**也写了一份存档（`streaming: true`），而这一轮所有
// 事件在 `applyToConversation` 走的是 active 分支、只更新顶层，`markDone` / `markError` / 点停止
// 同样只清顶层 ⇒ 那份存档里的 true 会一直留着（直到切走被新快照盖掉）。
// 两个用户可见后果：① 侧栏「正在生成」在回答结束后不消失；② 在别的会话里发送时误报
// 「当前另有 N 条会话正在运行」—— `othersRunning` 数的正是这些假条目。
describe('收口后，当前会话在存档里那份不许继续声称「在跑」（K9）', () => {
  const seeded = () => ({ ...bSnapshot, streaming: true })

  const armActiveRunning = (): void => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: { A: seeded() },
      concurrencyNotice: null
    })
  }

  it('markDone：顶层与存档一起落回 false', async () => {
    armActiveRunning()
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    expect(useAppStore.getState().streaming).toBe(false)
    expect(
      useAppStore.getState().runtimes.A?.streaming,
      '存档里那份还在说「在跑」—— 侧栏假标记与假并发提示的源头'
    ).toBe(false)
  })

  it('markError 同样要落回', async () => {
    armActiveRunning()
    useAppStore.getState().markError({ conversationId: 'A', payload: '断了' })
    await flush()
    expect(useAppStore.getState().runtimes.A?.streaming).toBe(false)
  })

  it('点停止也要落回（`stopStreaming` 不经 markDone，它自己清顶层）', async () => {
    armActiveRunning()
    await useAppStore.getState().stopStreaming()
    expect(useAppStore.getState().runtimes.A?.streaming).toBe(false)
  })

  it('阳性对照：后台那条真在跑时，当前这条收口不许把它一起清掉', async () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: { A: seeded(), B: seeded() },
      concurrencyNotice: null
    })
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    expect(useAppStore.getState().runtimes.B?.streaming, 'B 真在跑，被 A 的收尾顺手清掉是反向的错').toBe(true)
  })

  it('副作用二：A 收口之后在 B 里发送，不该弹「当前另有会话正在运行」', async () => {
    armActiveRunning()
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    const afterA = JSON.stringify(useAppStore.getState().runtimes.A?.streaming)
    useAppStore.setState({ activeId: 'B', messages: [], streaming: false, concurrencyNotice: null })
    await useAppStore.getState().sendMessage('B 的问题')
    expect(useAppStore.getState().concurrencyNotice, `A 已收口却仍被算成在跑（A.streaming=${afterA}）`).toBeNull()
  })

  it('阳性对照：B 真在跑时，在 A 里发送**必须**弹那条提示（别把判据改成永远不弹）', async () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: false,
      streamError: null,
      saveError: null,
      runtimes: { B: seeded() },
      concurrencyNotice: null
    })
    await useAppStore.getState().sendMessage('A 的问题')
    expect(useAppStore.getState().concurrencyNotice).toContain('当前另有 1 条会话正在运行')
  })
})

/**
 * 这条守的是 `settleRuntime` 里那句 `patched.runtimes ?? s.runtimes` —— 收口必须在
 * `applyToConversation` **已经算出的那份存档**上派生。它挡的不是"顺手清掉后台那条的标记"
 * （那个不可能，函数只按传入 id 取条目），而是更隐蔽的一件：事件属于**后台**那条时，
 * 若这里回头拿 `s.runtimes` 那份**旧存档**再派生一遍并排在后面，就会把刚写进去的 `streamError` 盖没。
 */
describe('后台那条会话的事件，不许被当前会话的收口逻辑用旧存档盖回去', () => {
  it('markError 打在后台会话上：存档里的错误原文必须留住', async () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: false,
      streamError: null,
      saveError: null,
      runtimes: { B: { ...bSnapshot, streamError: null } },
      concurrencyNotice: null
    })
    useAppStore.getState().markError({ conversationId: 'B', payload: 'B 自己断了' })
    await flush()
    expect(useAppStore.getState().runtimes.B?.streamError).toBe('B 自己断了')
    expect(useAppStore.getState().runtimes.B?.streaming).toBe(false)
  })
})

/**
 * 第一轮复查抓出的同根问题（比 K9 的"读数骗人"更重）：`newSession` / `createConversation`
 * 会直接把 `activeId` 改走，却**不**先把当前现场收进存档 ——
 * 于是 ① 已经吐出来的字留在顶层、被 `messages: []` 抹掉，而存档里还是发送那一刻的空助手轮，
 * done 落盘时把磁盘上的回答**盖成空**；② 顶层 `streaming` 再没人清（A 的 done 走的是非 active 分支），
 * 于是新会话里点发送被 `if (get().streaming) return` **静默吞掉**。
 */
describe('流式中途切走（新建任务 / 新建会话）不许丢内容、不许吞掉下一次发送', () => {
  const streamingA = (): void => {
    saved.length = 0
    fakeApi.chatSend.mockClear()
    fakeApi.createConversation.mockClear()
    useAppStore.setState({
      activeId: 'A',
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '已经吐出来的答案' }
      ],
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: {
        A: { ...bSnapshot, streaming: true, messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '' }] }
      },
      concurrencyNotice: null
    })
  }

  it('🐞 newSession 之后 A 收口：落盘的必须是已经吐出来的那份内容，不是发送时的空占位', async () => {
    streamingA()
    useAppStore.getState().newSession()
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    expect(saved.map((x) => x.messages.map((m) => m.content))).toEqual([['问', '已经吐出来的答案']])
  })

  it('🐞 newSession 之后顶层 streaming 必须落回，否则新会话首条被静默吞', async () => {
    streamingA()
    useAppStore.getState().newSession()
    expect(useAppStore.getState().streaming, '顶层还挂着 true —— 下一次 sendMessage 会直接 return').toBe(false)
    await useAppStore.getState().createConversation({ firstMessage: '新会话的问题' } as never)
    await useAppStore.getState().sendMessage('新会话的问题', { skipAppend: true })
    await flush()
    expect(fakeApi.chatSend, '被吞掉的发送：一次都没发出去，界面上也没有任何提示').toHaveBeenCalledTimes(1)
  })

  it('🐞 createConversation 也要先收档：A 已吐出的字不许在换显示时丢掉', async () => {
    streamingA()
    await useAppStore.getState().createConversation({ firstMessage: '新会话的问题' } as never)
    await flush()
    expect(
      useAppStore.getState().runtimes.A?.messages.map((m) => m.content),
      '存档里还是发送那一刻的空占位 —— 已吐出的字两头都没有'
    ).toEqual(['问', '已经吐出来的答案'])
  })

  /** K9 自己那条路的竞态：`stopStreaming` 在 `await chatAbort` 期间用户完全可以切会话 */
  it('🐞 点停止的 await 期间切走：被停的那条要落回，切进来的那条不许被顺手清', async () => {
    streamingA()
    useAppStore.setState({
      runtimes: {
        A: { ...bSnapshot, streaming: true },
        B: { ...bSnapshot, streaming: true }
      }
    })
    let release: (() => void) | null = null
    fakeApi.chatAbort.mockImplementationOnce(
      () => new Promise<void>((r) => { release = r })
    )
    const pending = useAppStore.getState().stopStreaming()
    await flush()
    // 停在 await 里时切走：此刻 activeId 与顶层说的都已经是 B，而"被停止"的是 A
    useAppStore.setState({ activeId: 'B', streaming: true })
    release?.()
    await pending
    expect(useAppStore.getState().runtimes.A?.streaming, 'A 被点了停止，存档却还说它在跑').toBe(false)
    expect(useAppStore.getState().runtimes.B?.streaming, 'B 没被停止，不许被 A 的收尾顺手清掉').toBe(true)
    expect(useAppStore.getState().streaming, '顶层此刻属于 B，按"当前这条"清就把 B 的生成中抹掉了').toBe(true)
  })

  it('阳性对照：当前会话在存档里本来没这一条时，收口不许凭空造一份空存档', async () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: {},
      concurrencyNotice: null
    })
    useAppStore.getState().markDone({ conversationId: 'A', payload: null })
    await flush()
    expect(useAppStore.getState().runtimes.A, '凭空造的条目会在打开该会话时按 undefined 切片直接崩').toBeUndefined()
  })
})

// 第二轮复查抓出：`openConversation` 换显示时会把 `todos` / `subagents` 一起重置，
// 而 `newSession` / `createConversation` 只清了 `toolEvents` 与 `reasoning`
// —— 于是上一条会话的待办与子代理面板会残留在「新建任务」页上。
describe('切到新建页不许留着上一条的待办与子代理面板', () => {
  it('newSession：todos 与 subagents 一起清空', () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: false,
      runtimes: {},
      todos: [{ id: 't1', text: '上一条的待办', status: 'pending' } as never],
      subagents: [{ agent: 'code-executor', status: 'running' } as never]
    })
    useAppStore.getState().newSession()
    expect(useAppStore.getState().todos).toEqual([])
    expect(useAppStore.getState().subagents).toEqual([])
  })
})

/**
 * K10：删掉一条会话，它那份"在跑"必须跟着消失。
 * 渲染端的 `removeConversation` 只改 `activeId`，**不摘存档条目** —— 而并发提示是按 `runtimes` 里
 * `streaming` 的条数算的（`sendMessage` 里的 `othersRunning`），于是删掉的会话变成一条幽灵，
 * 界面从此**永久**显示「当前另有 N 条会话正在运行」，且怎么点都消不掉。
 * ⚠️ 主进程那半边（删之前先 abort 正在跑的一轮）由 `chat-concurrency.test.ts` 的结构守卫管。
 * 落盘不会把它复活：`conversations-core · saveConversation` 读不到 meta 就返回 null（已核，不是新 bug）。
 */
describe('删掉的会话不许留下幽灵运行态（K10）', () => {
  const runningA = (): void => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: true,
      streamError: null,
      saveError: null,
      runtimes: { A: { ...bSnapshot, streaming: true }, B: { ...bSnapshot, streaming: true } },
      concurrencyNotice: null
    })
  }

  it('删当前这条：它的存档条目摘掉、顶层「在跑」落下', async () => {
    runningA()
    await useAppStore.getState().removeConversation('A')
    expect(useAppStore.getState().runtimes.A, '条目还在 —— 幽灵计数的源头').toBeUndefined()
    expect(useAppStore.getState().streaming).toBe(false)
  })

  it('删**后台**那条：摘掉之后，在剩下的会话里发送不该再弹「另有会话在跑」', async () => {
    runningA()
    useAppStore.setState({ activeId: 'B' })
    await useAppStore.getState().removeConversation('B')
    expect(useAppStore.getState().runtimes.B).toBeUndefined()
    useAppStore.setState({ activeId: 'A', streaming: false })
    await useAppStore.getState().sendMessage('A 的问题')
    expect(useAppStore.getState().concurrencyNotice, 'B 已删除却被算成在跑').toBeNull()
  })

  it('阳性对照：删 A 不许顺手把 B 的运行态也摘了（那是另一条真在跑的会话）', async () => {
    runningA()
    await useAppStore.getState().removeConversation('A')
    expect(useAppStore.getState().runtimes.B?.streaming, 'B 真在跑，被删 A 顺手清掉是反向的错').toBe(true)
  })

  it('桥要按**被删那条的 id** 调用（并发时代删错会话是事故）', async () => {
    runningA()
    await useAppStore.getState().removeConversation('A')
    expect(fakeApi.deleteConversation).toHaveBeenCalledWith('A')
  })
})

/**
 * K11（渲染端那一半）：回滚提示条说的是"盘上还留着一条尾巴，可以撤销"。
 * 一旦用户在回滚后的会话里继续说话，主进程下一次保存会按对账情形 ① **把尾巴作废**
 * （`conversations-core · saveConversation`），"撤销"当场变成假承诺 —— 提示条必须一起消失。
 * 硬闸（流式期间不许撤销）在主进程，见 `chat-concurrency.test.ts`。
 */
describe('回滚之后继续发送，提示条不许留着骗人（K11）', () => {
  it('sendMessage 把 rollbackNotice 清掉', async () => {
    useAppStore.setState({
      activeId: 'A',
      messages: structuredClone(A_MSGS),
      streaming: false,
      streamError: null,
      saveError: null,
      runtimes: {},
      rollbackNotice: { hidden: 2, total: 4, viaEdit: false },
      concurrencyNotice: null
    })
    await useAppStore.getState().sendMessage('接着问')
    expect(useAppStore.getState().rollbackNotice).toBeNull()
  })
})

