import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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
  'IPC.subagentChanged',
  'IPC.checkpointChanged',
  'IPC.confirmRequest',
  // ask:request —— 提问也带会话身份（界面要说明这条问题出自哪条会话），故同样只许走 emitter
  'IPC.askRequest'
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
  'IPC.terminalState'
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
