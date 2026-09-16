import { afterEach, describe, expect, it } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import { setHttpFetch } from '@main/providers/http-client'
import { streamWithToolsOpenAI } from '@main/providers/openai-agent'
import { streamWithToolsAnthropic } from '@main/providers/anthropic-agent'

// 守卫的**接线证明**（plan29 D-090）。
// ⚠️ 单测 `stream-guard.test.ts` 只能证明"这个守卫本身是对的" —— 它证明不了**provider 真的在用它**。
// 一个造好了没人调用的守卫，和没有守卫完全等价（本项目在 plan27 的台账里点过这个名：
// "恰好不算错的口径只会拿到恰好是假的绿灯"）。所以这里从 provider 的入口往下打，走真实的请求路径。
//
// 用的注入点是现成的 `setHttpFetch`（组合根本来就用它把 `net.fetch` 接进来）—— 不做模块 mock，
// 因为模块 mock 会把 `resolveApiUrl` / `buildToolsBody` / SSE 解析一起换掉，那测的就不是我们的代码了。

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60_000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  supportsImages: false
}

const SHORT = { timeouts: { firstByteMs: 30, idleMs: 30 } }

afterEach(() => {
  setHttpFetch(null)
})

/** 一个"连上了但永远不再吐数据"的响应体：只在中止时 reject —— 与真实 fetch 的行为一致。
 *  ⚠️ 必须先看 `signal.aborted` 再挂监听：真实 fetch 对**已经中止**的信号是**立刻** reject 的，
 *     只挂监听会永远错过那个已经发生的事件（写这个假实现时踩过一次，表现为测试挂到超时）。 */
const hangUntilAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    const fail = (): void =>
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    if (!signal) return // 没有 signal 就永远挂着（正是要测的那种"卡死"）
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })

function fakeRes(init: RequestInit, reader: () => Promise<{ done: boolean; value?: Uint8Array }>): Response {
  void init
  return { ok: true, body: { getReader: () => ({ read: reader }) } } as unknown as Response
}

const sse = (obj: unknown): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`)

describe('provider 真的接上了守卫（OpenAI 通道）', () => {
  it('首包迟迟不来 → 报**首包超时**（而不是笼统的"请求失败"）', async () => {
    setHttpFetch(async (_url, init) => fakeRes(init, () => hangUntilAbort(init.signal)))
    await expect(
      streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], () => {}, undefined, undefined, SHORT)
    ).rejects.toThrow('首包超时')
  })

  it('收到首包后静默 → 报**流中断**，且已经拿到的文本没有丢', async () => {
    let n = 0
    setHttpFetch(async (_url, init) =>
      fakeRes(init, () => {
        n += 1
        if (n === 1) {
          return Promise.resolve({ done: false, value: sse({ choices: [{ delta: { content: '前半句' } }] }) })
        }
        return hangUntilAbort(init.signal)
      })
    )
    const got: string[] = []
    await expect(
      streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], (d) => got.push(d), undefined, undefined, SHORT)
    ).rejects.toThrow('流中断')
    expect(got.join('')).toBe('前半句') // ← 分片间隔只在"真的不再来数据"时才掐，且已到的不回收
  })

  it('**用户主动停止 → 不报超时**（说成"超时"会让用户去查网络，其实是自己点的）', async () => {
    setHttpFetch(async (_url, init) => fakeRes(init, () => hangUntilAbort(init.signal)))
    const ac = new AbortController()
    const p = streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], () => {}, ac.signal, undefined, SHORT)
    // 等请求真的读起来再停 —— 走的是**中途停止**这条路（而不是"开始前就已经停了"）
    await new Promise((r) => setTimeout(r, 15))
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('开始前就已经停止 → 立刻收场，同样不报超时', async () => {
    setHttpFetch(async (_url, init) => fakeRes(init, () => hangUntilAbort(init.signal)))
    const ac = new AbortController()
    ac.abort()
    const p = streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], () => {}, ac.signal, undefined, SHORT)
    // 守卫建起来时信号就已中止 → 立刻中止底层请求（真实 fetch 对已中止的信号是立即 reject 的）
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('流正常结束 → 原样返回文本与会话不受守卫干扰', async () => {
    let n = 0
    setHttpFetch(async (_url, init) =>
      fakeRes(init, () => {
        n += 1
        if (n === 1) return Promise.resolve({ done: false, value: sse({ choices: [{ delta: { content: '你好' } }] }) })
        if (n === 2) return Promise.resolve({ done: false, value: new TextEncoder().encode('data: [DONE]\n\n') })
        return Promise.resolve({ done: true })
      })
    )
    const res = await streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], () => {}, undefined, undefined, SHORT)
    expect(res.text).toBe('你好')
    expect(res.toolCalls).toEqual([])
  })

  it('上游报 HTTP 错 → 仍是**原有的 HTTP 错误**，不被守卫的文案顶掉', async () => {
    setHttpFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) as unknown as Response)
    await expect(
      streamWithToolsOpenAI(settings, 'k', [{ role: 'user', content: 'x' }], [], () => {}, undefined, undefined, SHORT)
    ).rejects.toThrow(/401|密钥|鉴权|认证/)
  })
})

describe('provider 真的接上了守卫（Anthropic 通道）', () => {
  // Anthropic 侧为了不把整个函数体重缩进，把"守卫收尾"与"流本身"拆成了两个函数 ——
  // 这种结构改动最容易漏接线（包装层建了守卫、内层却没用），所以单独再验一遍。
  it('首包迟迟不来 → 同样报首包超时', async () => {
    setHttpFetch(async (_url, init) => fakeRes(init, () => hangUntilAbort(init.signal)))
    await expect(
      streamWithToolsAnthropic(
        { ...settings, providerType: 'anthropic' },
        'k',
        [{ role: 'user', content: 'x' }],
        [],
        () => {},
        undefined,
        SHORT
      )
    ).rejects.toThrow('首包超时')
  })

  it('中途静默 → 报流中断，已收到的文本保留', async () => {
    let n = 0
    setHttpFetch(async (_url, init) =>
      fakeRes(init, () => {
        n += 1
        if (n === 1) {
          return Promise.resolve({
            done: false,
            value: sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '半句' } })
          })
        }
        return hangUntilAbort(init.signal)
      })
    )
    const got: string[] = []
    await expect(
      streamWithToolsAnthropic(
        { ...settings, providerType: 'anthropic' },
        'k',
        [{ role: 'user', content: 'x' }],
        [],
        (d) => got.push(d),
        undefined,
        SHORT
      )
    ).rejects.toThrow('流中断')
    expect(got.join('')).toBe('半句')
  })
})
