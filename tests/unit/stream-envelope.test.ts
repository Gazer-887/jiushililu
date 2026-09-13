import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 结构性守卫：**流式事件必须带会话身份**（plan11 §2.5）。
 *
 * ## 为什么不是"扫 send 调用里有没有 conversationId"
 *
 * 初稿写的就是那种扫法，审查逐条证明它是**假绿灯**：
 *   ① 初稿把通道名写成 `chat:delta`，真名是 `chat:chunk` → 扫的词根本不匹配；
 *   ② 已经存在包装过的 sender（`confirm.ts` 的 `deps.send`、`index.ts` 那一处）→ 扫 `.send(` 扫不到；
 *   ③ prettier 会把调用折行 → "同一行里看得见 conversationId"这个判据**依赖排版**；
 *   ④ 注释里出现 `conversationId` 就能骗过匹配。
 *
 * 所以改成**结构性**的两条：
 *   A. **主进程里只有一个文件**能引用流式通道常量（`main/chat-emitter.ts`），
 *      而那个文件把 `conversationId` 在**构造时闭包捕获** —— 漏带 id 在结构上不可能发生；
 *   B. `main/ipc.ts` 里**一个裸 `.send(` 都不许有**（全部走 emitter）。
 *
 * 这两条都是"数一数、比一比"，**不依赖排版、注释、换行**，可判定。
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
  'IPC.confirmRequest'
] as const

/** 唯一允许出现流式通道常量的主进程文件 */
const EMITTER = 'src/main/chat-emitter.ts'

/**
 * **豁免**：进程级通道不进信封（它们本来就跨会话可见 —— plan11 §2.3 的取舍）。
 * 豁免要写在这里、写明白，不许靠"扫不到"蒙混过去。
 *
 * ⚠️ 每一条**必须带理由注释**（下面有一条断言盯着这件事，注释不许省）。
 * 理由本身也写在 `src/main/chat-emitter.ts` 的「例外」那一节里 —— 两处呼应。
 */
const EXEMPT_CONSTS = [
  // bg:changed —— "系统里在跑什么后台命令"跨会话可见，不属于任何一条会话
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
        // ⚠️ 匹配的是**属性定义**（`onChatChunk:`），不是调用（`onChatChunk(`）——
        //    第一版写成 `\(` 结果一个都没扫到，是下面的"防空转"断言把**我自己**抓出来的
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
    // 本项目踩过"文件被改名/挪走 → 守卫读不到 → 静默通过"的坑，
    // 所以这里先断言入口本身是实的（空文件/读不到都得先炸）
    for (const rel of ['src/main/ipc.ts', 'src/preload/index.ts', EMITTER]) {
      expect(read(rel).length, `${rel} 读不到或为空 —— 上面的断言会全部静默变绿`).toBeGreaterThan(500)
    }
  })

  it('豁免清单写明白了（进程级通道不进信封）', () => {
    expect(EXEMPT_CONSTS.length).toBeGreaterThan(0)
    expect(STREAM_CONSTS.length).toBeGreaterThan(EXEMPT_CONSTS.length)
  })

  /**
   * ⚠️ 这一条是**补实**原守卫的（plan14 的审查指出）：原注释承诺"豁免要写明白，
   * 不许靠扫不到蒙混过去"，但 `EXEMPT_CONSTS` 其实**没有任何机械效果** ——
   * 不进 `STREAM_CONSTS` 的常量本来就扫不到，一个字不改它也会绿。
   * 于是补两条真的：
   *   ① 每个豁免项**旁边必须写理由**（注释不许省）
   *   ② 清单里的常量串**必须真出现在 `ipc.ts` 里**（改名/打错字后守卫静默失效）
   */
  it('**每个豁免项旁边都写了理由**（不许只写个常量名）', () => {
    const lines = readFileSync(__filename, 'utf8').split('\n')
    const missing = EXEMPT_CONSTS.filter((c) => {
      const i = lines.findIndex((l) => l.includes(`'${c}'`))
      if (i < 0) return true
      // 它自己那行、或上面两行里要有注释
      return ![lines[i - 1], lines[i - 2], lines[i], lines[i + 1]].some(
        (l) => l !== undefined && l.includes('//')
      )
    })
    expect(missing, '这些豁免项没写理由 —— 豁免必须写明白').toEqual([])
  })

  it('**清单里的通道常量必须真的存在**（防改名/打错字后守卫静默失效）', () => {
    const ipcSrc = read('src/shared/ipc.ts')
    const all = [...STREAM_CONSTS, ...EXEMPT_CONSTS]
    // ⚠️ 注意查的是**属性名**（`chatChunk:`）而不是 `IPC.chatChunk` ——
    //    常量在 ipc.ts 里是裸属性名，`IPC.` 前缀只在**使用处**出现。
    //    （这一版我第一稿就写错了：查全名 → 12 条全"找不到"，是这条断言自己把我抓住的。）
    const missing = all.filter((c) => {
      const name = c.replace(/^IPC\./, '')
      return !new RegExp(`\\b${name}\\s*:`).test(ipcSrc)
    })
    expect(missing, '这些常量在 ipc.ts 里找不到 —— 是不是改名了？那守卫就空转了').toEqual([])
  })
})
