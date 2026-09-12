import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc'

/**
 * **串台回归门 + 落盘归属门**（plan11 §四 步骤 1）。
 *
 * 这两条针对的都是**现存缺陷**（不是新功能）：
 *   ① **切会话串台**：A 正在吐字时你切到 B，后面的字会落进 B；
 *   ② **后台会话整轮丢**：`markDone()` 只落"当前显示的那条会话"，
 *      在后台跑完的那条**谁也不会替它落盘**。
 *
 * 所以它们必须在**旧代码上是红的** —— 红才说明抓得住（绿就是写错了）。
 * 判据盯着**结果**（内容落到哪条会话、落盘用的是哪个 id），不盯实现细节。
 */

/** 假桥：只实现被测路径用到的那几个方法 */
const saved: { id: string; messages: ChatMessage[] }[] = []
const fakeApi = {
  saveConversation: vi.fn(async (id: string, messages: ChatMessage[]) => {
    saved.push({ id, messages: structuredClone(messages) })
    return null // 不更新列表，避免把这条路径之外的逻辑牵进来
  }),
  chatSend: vi.fn(async () => undefined),
  chatAbort: vi.fn(async () => undefined)
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
    // B 在后台跑，来了一个属于 B 的片段
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
