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
 * **豁免**：进程级通道不进信封（它本来就跨会话可见 —— plan11 §2.3 的取舍）。
 * 豁免要写在这里、写明白，不许靠"扫不到"蒙混过去。
 */
const EXEMPT_CONSTS = ['IPC.bgChanged'] as const

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
})
