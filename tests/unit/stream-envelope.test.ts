import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { WebContents } from 'electron'
import { IPC, chatErrorMessage, type ChatErrorPayload } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'
import type { RunTerminal } from '@shared/execution-outcome'
import { createChatEmitter } from '@main/chat-emitter'
// E26a-R1：运行真实 preload 实现，仅 mock electron 边界。
import '../../src/preload/index'

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  let exposed: unknown = null
  return {
    listeners,
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        listeners.set(channel, listener)
      },
      removeListener: () => {},
      invoke: async () => undefined
    },
    contextBridge: {
      exposeInMainWorld: (_key: string, api: unknown) => {
        exposed = api
      }
    },
    webUtils: { getPathForFile: () => '' },
    getExposed: () => exposed
  }
})

vi.mock('electron', () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
  webUtils: electronMock.webUtils
}))

/**
 * 结构性守卫：**流式事件必须带会话身份**（plan11 §2.5）。
 *
 * ⚠️ 不许换成"扫 `.send(` 调用里有没有 conversationId"那种写法 —— 它是**假绿灯**：通道名写错就匹配不上、
 * 包装过的 sender 扫不到、判据随 prettier 折行而变、注释里出现关键词就能骗过。
 * 只认两条不依赖排版的可判定条件：① 主进程里只有 `main/chat-emitter.ts` 能引用流式通道常量
 * （它构造时闭包捕获 `conversationId`，漏带 id 在结构上不可能）；② `main/ipc.ts` 里一个裸 `.send(` 都不许有。
 */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** 流式/推送通道常量 —— 带了会话身份的那些 */
const STREAM_CONSTS = [
  'IPC.chatChunk',
  'IPC.chatReasoning',
  'IPC.chatTool',
  'IPC.chatDone',
  'IPC.chatError',
  'IPC.todoChanged',
  // goal:changed —— Agent 自建目标是**某条会话**的事（plan12 ⑤），进会话信封
  'IPC.goalChanged',
  'IPC.subagentChanged',
  'IPC.checkpointChanged',
  'IPC.confirmRequest',
  // ask:request —— 提问也带会话身份（界面要说明这条问题出自哪条会话），故同样只许走 emitter
  'IPC.askRequest',
  // plan:approve-request（plan27）—— 计划批准同样必须带会话身份：并发时用户会批了**另一条会话**的方案
  'IPC.planApprovalRequest'
] as const

/** 唯一允许出现流式通道常量的主进程文件 */
const EMITTER = 'src/main/chat-emitter.ts'

/**
 * **豁免**：进程级通道不进信封（它们本来就跨会话可见 —— plan11 §2.3 的取舍）。
 * ⚠️ 每一条**必须带理由注释**（下面有断言盯着，删了会红），理由在 `main/chat-emitter.ts` 的「例外」一节也有一份。
 */
const EXEMPT_CONSTS = [
  // bg:changed —— "后台在跑什么命令"跨会话可见，不属于任何一条会话
  'IPC.bgChanged',
  // terminal:data —— 终端是**这个工作区**的终端，不是"某条对话的终端"（plan7 批 C）
  'IPC.terminalData',
  // terminal:state —— 同上：会话起停是工作区级状态，界面据此刷新，不带会话信封
  'IPC.terminalState',
  // settings:changed —— 设置是**全应用**的（主题/权限档/供应商），不属于任何一条会话；设置独立窗口
  // 与主窗口是两个渲染进程，改了必须让另一个知道（2026-09-13）
  'IPC.settingsChanged',
  // git:changed —— Git 状态是**工作区级**的（Agent 改文件、终端跑命令、面板自己提交都会弄脏它），
  // 不是"某条对话的改动"，故不进会话信封（plan16）
  'IPC.gitChanged'
] as const

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walkTs(abs, out)
    else if (/\.tsx?$/.test(name)) out.push(abs)
  }
  return out
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('流式事件必须带会话身份（plan11 §2.5 结构性守卫）', () => {
  it('main/ipc.ts 里**一个裸 `.send(` 都不许有**（发送只能走 emitter 的唯一工厂）', () => {
    const offenders = stripComments(read('src/main/ipc.ts'))
      .split('\n')
      .map((line, i) => ({ n: i + 1, line: line.trim() }))
      .filter((x) => /\.send\(/.test(x.line))
      .map((x) => `${x.n}: ${x.line}`)
    expect(offenders, '这些地方绕过了唯一发送口，漏带 id 就从这儿开始').toEqual([])
  })

  it(`主进程里只有 ${EMITTER} 能引用流式通道常量`, () => {
    const files = walkTs(join(ROOT, 'src/main'))
    const offenders: string[] = []
    for (const abs of files) {
      const rel = relative(ROOT, abs).replace(/\\/g, '/')
      if (rel === EMITTER) continue
      const src = stripComments(readFileSync(abs, 'utf8'))
      for (const c of STREAM_CONSTS) {
        if (src.includes(c)) offenders.push(`${rel} → ${c}`)
      }
    }
    expect(offenders, '主进程里出现流式通道常量 = 有人绕开了带 id 的唯一发送口').toEqual([])
  })

  it('preload 的流式订阅**不许把载荷塌成 string**（`as string` 就是把 id 丢掉的那一行）', () => {
    const src = read('src/preload/index.ts')
    const lines = src
      .split('\n')
      .map((line, i) => ({ n: i + 1, line: line.trim() }))
      .filter((x) =>
        // ⚠️ 匹配的是**属性定义**（`onChatChunk:`）而非调用（`onChatChunk(`）—— 写成 `\(` 会一个都扫不到，靠下面的"防空转"断言兜住
        /on(ChatChunk|ChatReasoning|ChatDone|ChatError|ChatTool|TodoChanged|SubagentChanged|CheckpointChanged|ConfirmRequest)\s*:/.test(
          stripComments(x.line)
        )
      )
    expect(lines.length, '一个流式订阅都没找到 —— 说明这个守卫扫错了地方（防空转）').toBeGreaterThanOrEqual(4)
    const offenders = lines.filter((x) => /as string/.test(x.line)).map((x) => `${x.n}: ${x.line}`)
    expect(offenders, '主进程带了 id、到这一层被塌掉，等于没做').toEqual([])
  })

  it('preload 的 chatSend / chatAbort 必须携带 conversationId', () => {
    const src = read('src/preload/index.ts')
    const send = src.split('\n').find((l) => /chatSend:/.test(l)) ?? ''
    const abort = src.split('\n').find((l) => /chatAbort:/.test(l)) ?? ''
    expect(send, 'chatSend 没带会话身份 —— 主进程不知道该把这次跑记到哪条会话上').toContain(
      'conversationId'
    )
    expect(abort, 'chatAbort 没带会话身份 —— 并发时"停止"会停错会话').toContain('conversationId')
  })

  it('守卫不是空转：被扫的文件都存在且有内容', () => {
    // ⚠️ 文件被改名/挪走 → 守卫读不到 → 静默全绿；所以先断言入口本身是实的（读不到或为空都得先炸）
    for (const rel of ['src/main/ipc.ts', 'src/preload/index.ts', EMITTER]) {
      expect(read(rel).length, `${rel} 读不到或为空 —— 上面的断言会全部静默变绿`).toBeGreaterThan(500)
    }
  })

  it('豁免清单写明白了（进程级通道不进信封）', () => {
    expect(EXEMPT_CONSTS.length).toBeGreaterThan(0)
    expect(STREAM_CONSTS.length).toBeGreaterThan(EXEMPT_CONSTS.length)
  })

  /** ⚠️ `EXEMPT_CONSTS` 本身**没有机械效果**（不进 `STREAM_CONSTS` 的常量本来就扫不到，一个字不改也会绿），
   *  豁免不许靠"扫不到"蒙混、必须有机械抓手：① 每个豁免项**旁边必须写理由**；
   *  ② 清单里的常量串**必须真出现在 `ipc.ts` 里**（改名/打错字后守卫静默失效）。 */
  it('**每个豁免项旁边都写了理由**（不许只写个常量名）', () => {
    const lines = readFileSync(__filename, 'utf8').split('\n')
    const missing = EXEMPT_CONSTS.filter((c) => {
      const i = lines.findIndex((l) => l.includes(`'${c}'`))
      if (i < 0) return true
      return ![lines[i - 1], lines[i - 2], lines[i], lines[i + 1]].some(
        (l) => l !== undefined && l.includes('//')
      )
    })
    expect(missing, '这些豁免项没写理由 —— 豁免必须写明白').toEqual([])
  })

  it('**清单里的通道常量必须真的存在**（防改名/打错字后守卫静默失效）', () => {
    const ipcSrc = read('src/shared/ipc.ts')
    const all = [...STREAM_CONSTS, ...EXEMPT_CONSTS]
    // ⚠️ 查的是**属性名**（`chatChunk:`）而非 `IPC.chatChunk` —— 常量在 ipc.ts 里是裸属性名、前缀只在使用处出现，查全名会 12 条全"找不到"
    const missing = all.filter((c) => {
      const name = c.replace(/^IPC\./, '')
      return !new RegExp(`\\b${name}\\s*:`).test(ipcSrc)
    })
    expect(missing, '这些常量在 ipc.ts 里找不到 —— 是不是改名了？那守卫就空转了').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E26a：错误/收尾封套与单结算（行为测试，不是结构扫描）

type SentEvent = { channel: string; conversationId: string; payload: unknown }

function fakeWin(): { win: WebContents; sent: SentEvent[] } {
  const sent: SentEvent[] = []
  const win = {
    isDestroyed: () => false,
    send: (channel: string, envelope: { conversationId: string; payload: unknown }) => {
      sent.push({ channel, conversationId: envelope.conversationId, payload: envelope.payload })
    }
  } as unknown as WebContents
  return { win, sent }
}

const USAGE: TokenUsage = {
  promptTokens: 100,
  completionTokens: 10,
  cachedPromptTokens: null,
  cacheWritePromptTokens: null,
  reasoningTokens: null
}
const TERMINAL: RunTerminal = { state: 'failed', code: 'upstream-error' }

describe('E26a 错误/收尾封套与单结算', () => {
  it('旧路径：error(string) 仍发字符串且带 conversationId', () => {
    const { win, sent } = fakeWin()
    const emit = createChatEmitter(win, 'conv-old')
    emit.error('旧的字符串错误')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ channel: IPC.chatError, conversationId: 'conv-old', payload: '旧的字符串错误' })
  })

  it('新路径：error(message, details) 携带整轮已知账、完整性与固定终态', () => {
    const { win, sent } = fakeWin()
    const emit = createChatEmitter(win, 'conv-new')
    emit.error('对话执行失败', {
      terminal: TERMINAL,
      usage: USAGE,
      usageComplete: true,
      avoided: 0,
      tier: 'balanced',
      memoryTokens: 12
    })
    expect(sent).toHaveLength(1)
    const payload = sent[0].payload as ChatErrorPayload
    expect(payload).toMatchObject({
      message: '对话执行失败',
      terminal: TERMINAL,
      usage: USAGE,
      usageComplete: true,
      avoided: 0,
      tier: 'balanced',
      memoryTokens: 12
    })
    // 已知 0 保真：不被 falsy 判断吃掉
    expect(payload.usage?.completionTokens).toBe(10)
    expect(payload.avoided).toBe(0)
  })

  it('新路径：未知 avoided/tier 不造字段；全漏报 usage=null + complete=false', () => {
    const { win, sent } = fakeWin()
    const emit = createChatEmitter(win, 'conv-unknown')
    emit.error('对话执行失败', { terminal: { state: 'unknown', code: 'missing-terminal' }, usage: null, usageComplete: false })
    const payload = sent[0].payload as ChatErrorPayload
    expect(payload.usage).toBeNull()
    expect(payload.usageComplete).toBe(false)
    expect('avoided' in payload).toBe(false)
    expect('tier' in payload).toBe(false)
    expect('memoryTokens' in payload).toBe(false)
  })

  it('done：只追加可选 terminal；未给时字段不出现', () => {
    const withTerminal = fakeWin()
    createChatEmitter(withTerminal.win, 'c1').done(USAGE, 0, undefined, 0, false, { state: 'completed' })
    expect(withTerminal.sent[0].payload).toMatchObject({ usageComplete: false, terminal: { state: 'completed' } })

    const without = fakeWin()
    createChatEmitter(without.win, 'c2').done(null, 0, undefined, 0, false)
    expect('terminal' in (without.sent[0].payload as object)).toBe(false)
    expect('tier' in (without.sent[0].payload as object)).toBe(false)
  })

  it('单结算：done/error 先到者生效，后续不重复发终止事件', () => {
    const first = fakeWin()
    const emit1 = createChatEmitter(first.win, 'c-done-first')
    emit1.chunk('过程')
    emit1.done(USAGE, 0)
    emit1.done(USAGE, 0)
    emit1.error('迟到的错误')
    expect(first.sent.filter((e) => e.channel === IPC.chatDone)).toHaveLength(1)
    expect(first.sent.filter((e) => e.channel === IPC.chatError)).toHaveLength(0)

    const second = fakeWin()
    const emit2 = createChatEmitter(second.win, 'c-error-first')
    emit2.error('先失败', { terminal: TERMINAL, usage: USAGE, usageComplete: true })
    emit2.done(USAGE, 0)
    emit2.error('第二次错误')
    expect(second.sent.filter((e) => e.channel === IPC.chatError)).toHaveLength(1)
    expect(second.sent.filter((e) => e.channel === IPC.chatDone)).toHaveLength(0)
  })

  it('chatErrorMessage：旧 string / 新对象 / 坏输入都归一，且不把对象序列化漏给界面', () => {
    expect(chatErrorMessage('旧错误')).toBe('旧错误')
    expect(chatErrorMessage({ message: '固定映射', terminal: TERMINAL })).toBe('固定映射')
    expect(chatErrorMessage({ cause: 'CANARY-SECRET' })).toBe('对话执行失败')
    expect(chatErrorMessage({ message: 'CANARY-SECRET', cause: 'x' })).toBe('CANARY-SECRET')
    expect(chatErrorMessage(null)).toBe('对话执行失败')
    expect(chatErrorMessage(42)).toBe('对话执行失败')
  })

  it('canary 隐私：结构化错误只保留白名单字段，不带 cause/厂商正文', () => {
    const { win, sent } = fakeWin()
    const emit = createChatEmitter(win, 'c-privacy')
    emit.error('对话执行失败', { terminal: TERMINAL, usage: USAGE, usageComplete: true })
    const payload = sent[0].payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['message', 'terminal', 'usage', 'usageComplete'])
    expect(JSON.stringify(payload)).not.toContain('CANARY-SECRET')
  })
})

// E26a-R1：真实 preload 订阅回调 —— 结构化错误事实不得在桥接层被塌成 message
type PreloadErrorApi = {
  onChatError: (cb: (e: { conversationId: string; payload: unknown }) => void) => () => void
}

describe('E26a-R1 preload 错误桥接：结构化事实必须原样保留', () => {
  const api = (): PreloadErrorApi => electronMock.getExposed() as PreloadErrorApi

  function subscribe(): Array<{ conversationId: string; payload: unknown }> {
    const got: Array<{ conversationId: string; payload: unknown }> = []
    api().onChatError((e) => got.push(e))
    expect(electronMock.listeners.get(IPC.chatError), 'preload 没有注册 chat:error 监听').toBeTruthy()
    return got
  }

  function emit(envelope: unknown): void {
    const listener = electronMock.listeners.get(IPC.chatError)
    expect(listener, 'chat:error 监听不存在').toBeTruthy()
    listener!(null, envelope)
  }

  beforeEach(() => electronMock.listeners.clear())

  it('旧 string 载荷保持 string（旧路径兼容）', () => {
    const got = subscribe()
    emit({ conversationId: 'conv-old', payload: '旧字符串错误' })
    expect(got).toEqual([{ conversationId: 'conv-old', payload: '旧字符串错误' }])
  })

  it('新结构化载荷：terminal/usage/usageComplete/avoided/tier 经过回调仍在', () => {
    const payload: ChatErrorPayload = {
      message: '对话执行失败',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: null,
        cacheWritePromptTokens: null,
        reasoningTokens: null
      },
      usageComplete: false,
      avoided: 0,
      tier: 'balanced',
      memoryTokens: 5
    }
    const got = subscribe()
    emit({ conversationId: 'conv-new', payload })
    expect(got).toHaveLength(1)
    expect(got[0].conversationId).toBe('conv-new')
    // 关键：不能被塌成 message 字符串
    expect(got[0].payload).toEqual(payload)
    expect((got[0].payload as ChatErrorPayload).usage?.promptTokens).toBe(0)
    expect((got[0].payload as ChatErrorPayload).avoided).toBe(0)
  })

  it('全漏报 usage=null 与 complete=false 原样保留', () => {
    const payload: ChatErrorPayload = {
      message: '对话执行失败',
      terminal: { state: 'unknown', code: 'missing-terminal' },
      usage: null,
      usageComplete: false
    }
    const got = subscribe()
    emit({ conversationId: 'conv-null', payload })
    const received = got[0].payload as ChatErrorPayload
    expect(received.usage).toBeNull()
    expect(received.usageComplete).toBe(false)
    expect('avoided' in received).toBe(false)
    expect('tier' in received).toBe(false)
  })

  it('conversationId 在所有载荷类型下都不丢', () => {
    const got = subscribe()
    emit({ conversationId: 'conv-string', payload: 'x' })
    emit({
      conversationId: 'conv-object',
      payload: { message: 'y', terminal: { state: 'failed' }, usage: null, usageComplete: false }
    })
    expect(got.map((e) => e.conversationId)).toEqual(['conv-string', 'conv-object'])
  })
})
