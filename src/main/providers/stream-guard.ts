// 流式请求的两层守卫（plan29 D-090）：**首包**与**分片间隔**。
//
// 为什么要拆出这两层，而不是留一个"整轮墙钟"：
// 整轮墙钟把「请求发不出去 / 首包迟迟不来 / 吐了一半断流 / 工具跑得久 / 子代理在并行」**五种性质完全不同**的
// 情况压成一个数字，于是任何一种慢都会被报成同一句话（原来那句是「请求超时」）—— 用户按那句话去调大超时，
// 结果是把本来正常的情况也一起等更久。六家同类产品（Claude Code / OpenCode / Codex CLI / Aider / Continue /
// OpenAI Node SDK）**无一设整轮墙钟**，全部把超时定义在更小的粒度上。
//
// 其中**分片间隔是唯一能识别"真卡死"的指标** —— "慢"是还在来数据，"卡死"是数据不再来了，
// 这两件事只有分片间隔分得开（外部实证：OpenCode 曾因头超时太紧而陷入"掐断→重试→再掐断"的死循环，
// 社区解法正是拆口径，而不是把数字调大）。
//
// ⚠️ 本模块不 import electron（与 runner / 各 provider 同一条约束），要能进单测链路。

/** 两个口径的默认值。**没有做成用户设置**：它们是"识别卡死"的技术参数，不是用户偏好 ——
 *  普通用户没有依据去判断"分片间隔该设 60s 还是 120s"，多一个旋钮只会多一个调坏的入口。 */
export const DEFAULT_STREAM_TIMEOUTS: StreamGuardTimeouts = {
  /** 从发起请求到**第一个分片**（含建连、排队、首 token） */
  firstByteMs: 60_000,
  /** 两个分片之间的最大静默时长（**卡死判据**） */
  idleMs: 90_000
}

export interface StreamGuardTimeouts {
  firstByteMs: number
  idleMs: number
}

export type StreamTimeoutKind = 'first-byte' | 'idle'

export interface StreamGuard {
  /** 传给 `httpFetch` 的 signal：**用户主动停止**与**守卫超时**都走它 */
  signal: AbortSignal
  /** 每收到一个分片调一次 —— 重置分片间隔计时（这就是"卡死"与"慢"的分界） */
  onChunk(): void
  /** 收尾：停表 + 退订。**必须调**，否则一个 60s 的计时器会一直挂着 */
  dispose(): void
  /**
   * 超时了给一句可直接给用户看的话；**没超时返回 null**。
   * ⚠️ 判据是"守卫自己有没有开过枪"，不是"signal 有没有被 abort" ——
   * 用户点停止同样会 abort，那是两件完全不同的事（一个是"我们不等了"，一个是"你别做了"）。
   */
  timeoutMessage(): string | null
  /** 本轮是不是**用户主动**停止的（守卫没开过枪，且用户的 signal 已 abort） */
  userAborted(): boolean
}

export interface StreamGuardOptions {
  timeouts?: Partial<StreamGuardTimeouts>
  /** 超时瞬间的回调（打日志用）；不改变收尾行为 */
  onTimeout?: (kind: StreamTimeoutKind, ms: number) => void
}

export function createStreamGuard(userSignal?: AbortSignal, opts: StreamGuardOptions = {}): StreamGuard {
  const t: StreamGuardTimeouts = { ...DEFAULT_STREAM_TIMEOUTS, ...opts.timeouts }
  const ctrl = new AbortController()
  /** 守卫开的枪（null = 没开过）—— 与"用户的 signal 被 abort"严格区分 */
  let fired: StreamTimeoutKind | null = null
  let sawChunk = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const arm = (): void => {
    clearTimer()
    const first = !sawChunk
    const wait = first ? t.firstByteMs : t.idleMs
    timer = setTimeout(() => {
      timer = null
      fired = first ? 'first-byte' : 'idle'
      opts.onTimeout?.(fired, wait)
      // 停掉底层连接：只 reject 上层 Promise 的话，那条 TCP 连接会一直挂着占资源
      ctrl.abort()
    }, wait)
    // 计时器不该把进程钉住（Node 下 Electron 退出 / 单测收尾都可能被它拖住）。
    // 浏览器环境 `setTimeout` 返回数字，没有 unref —— 故用可选调用而不是直接调。
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  const onUserAbort = (): void => ctrl.abort()
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort()
    else userSignal.addEventListener('abort', onUserAbort, { once: true })
  }

  arm()

  return {
    signal: ctrl.signal,

    onChunk() {
      sawChunk = true
      arm()
    },

    dispose() {
      clearTimer()
      userSignal?.removeEventListener('abort', onUserAbort)
    },

    timeoutMessage() {
      if (fired === 'first-byte') {
        return (
          `模型在 ${t.firstByteMs / 1000}s 内没有返回任何内容（首包超时）。` +
          '可能原因：网络或代理不通、端点地址不对、该模型当前响应很慢。'
        )
      }
      if (fired === 'idle') {
        return (
          `模型已连续 ${t.idleMs / 1000}s 没有输出新内容（流中断）。` +
          '连接还在，但数据不再来了 —— 通常是上游中断或网络抖动，重试一次往往就好。'
        )
      }
      return null
    },

    userAborted() {
      return fired === null && userSignal?.aborted === true
    }
  }
}
