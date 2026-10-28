import type {
  AgentChatResult,
  AgentMessage,
  AgentLoopResult,
  AgentTool,
  RunRequestPolicy,
  StagedToolRead,
  ToolCall,
  ToolEvent,
  ToolImageRef,
  ToolOutcome,
  TrustedReadCapability
} from '@shared/agent'
import type { RunTerminal } from '@shared/execution-outcome'
import { toolCallDetail, toolArtifactPaths } from '@shared/tool-detail'
import { windowToolOutput } from '@shared/tool-window'
import { createLogger } from '../log'
import { setWatchdogPhase, traceSync } from '../watchdog'
import { DEFAULT_TOKEN_TIER, resolvePolicy, type TokenPolicy } from '@shared/token-tier'
import { historyForModel, trimMessages, type TrimOptions } from './context'
import type { ExecEventRecorder } from './exec-events'
import { AgentRunFailure, ProviderError, isAbortError } from '../providers/errors'
import { AgentPauseError } from './pause-error'
import { runToolBatch } from './tool-batch'
import { isTrustedReadTool } from './tools/file-tools'

// Agent 主循环（plan6；D-032 流式化）：模型 → 工具调用 → 结果回灌 → 循环，直到出最终答案或预算耗尽。
// 缰绳：maxRounds 是硬上限（D5 决策），卡死必须能停；contextWindow 控历史裁剪。
// plan8 R9.1：窗口化只挂在**结果回灌这一处** —— 它是唯一入口，挂两处迟早漏一处（踩过）。

/**
 * **自己管好输出的工具**：不给窗口化再加工 —— `read_file` 已按行窗口给过并如实告知，
 * 再压一次等于把「第 1–200 行」砍成「头 60 尾 40」，而模型要的正是那 200 行。
 * 判据挂在**工具名**上而不是"看输出像不像"——"像不像"迟早会判错。
 */
const SELF_MANAGED_TOOLS = new Set(['read_file'])

export interface AgentLoopOptions {
  /** 用户停止信号：模型和工具派发共用；已完成的副作用不自动回滚。 */
  signal?: AbortSignal
  /**
   * 权限/活性守卫（同步）：每项真实启动前、异步准备后的读盘前各核一次；可带工具名。
   * 返回 false 或抛错 = 不许启动。提交门用 `canCommit`，默认回落到 `canStart('read_file')`。
   */
  canStart?: (toolName?: string) => boolean
  /** 提交门前置（同步）：暂存读取的版本与结果是否仍可提交；缺省回落到 canStart。 */
  canCommit?: () => boolean
  systemPrompt: string
  /** 对话历史（不含 system；本循环在最前面补 system）。D-032：带完整历史，多轮有记忆 */
  history: AgentMessage[]
  tools: AgentTool[]
  /** 轮数硬上限（默认 12）：一轮 = 一次模型调用 + 其工具执行 */
  maxRounds?: number
  /** 上下文窗口（token）；给了才启用历史裁剪 */
  contextWindow?: number
  /** 模型通道（注入式依赖）：streaming 时把文本增量喂给 onText，返回累积后的完整结果 */
  chat(messages: AgentMessage[], onText: (delta: string) => void): Promise<AgentChatResult>
  /** 文本增量回调（流式上屏）；不传则忽略 */
  onText?: (delta: string) => void
  /**
   * 是否启用工具输出窗口化（plan8 R9.1），默认**开**。留开关是为了效果能被 A/B 量出来
   * （同一段任务开/关各跑一遍比 usage）；排查"模型没看见原文"时也靠它先关掉再复现。
   */
  toolWindow?: boolean
  /**
   * 省 token 档位解析出的开关（plan8 R9.1 §七②）。**调用方只给 policy、不认识档位名**，
   * 加档 / 改取值只动 `@shared/token-tier`；不给 = 平衡档（与改造前一致）。
   */
  policy?: TokenPolicy
  /**
   * run 级不可变请求策略（S3-20D1）：由 `runAgent` 在检查点之后解析**一次**并冻结，主循环与子代理共享。
   * ⚠️ 本层只接收、不解析：不得读 UI 偏好或按当前设置重算，否则同一 run 会中途漂移。
   */
  requestPolicy?: RunRequestPolicy
  /** 工具执行生命周期（界面显示"正在读 xx / 完成 / 失败"） */
  onToolEvent?: (evt: ToolEvent) => void
  /**
   * 本轮实际执行的 Agent 标签（E30-P2）：run_start 的 agentName 用它。
   * 必须与结果里的 `agent` 同源（unknown/默认 = 「内核默认」），不得另造显示名。
   */
  agentLabel?: string
  /**
   * 执行事件流（plan26 D-077）：工具/裁剪/起止的结构化留痕，落盘由组合根装配。
   * **可选依赖** —— 不传 = 不记录（单测与既有路径零影响）。
   * ⚠️ 记的是元数据白名单字段；工具入参与输出正文**不进事件流**（隐私口径见 exec-events.ts）。
   */
  execEvents?: ExecEventRecorder
  /**
   * 滚动摘要（plan26 D-080）：裁剪发生时，对被裁段 + 旧摘要调一次模型。
   * **由 runner 装配**（它持有模型通道与用量账）；不传 = 机械占位（现状行为）。
   * fail-soft 是**调用方**的职责（本循环只认 Promise 结果，null = 没摘要出来）。
   * prior（旧摘要）由回调内部从缓存读 —— 本循环不持有缓存。
   * ⚠️ 摘要文本会进消息流（替换占位），但**不进执行事件流**（D-077 正文禁区）。
   */
  summarize?: (dropped: AgentMessage[]) => Promise<string | null>
  /**
   * 工具输出被窗口化时回调（plan8 R9.1）。压缩**不许静默**：界面那条痕是内存态、
   * 会随重挂载丢，所以还得有一条能事后追的（主进程日志由调用方接上）。
   */
  onToolWindowed?: (info: { name: string; beforeTokens: number; afterTokens: number; reason: string }) => void
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 模型吐了非法 JSON——把原文原样交回让它看到错误，而不是静默吞掉
    return { __raw: raw }
  }
}

/** 结果摘要（界面显示用）：折叠空白 + 截断 */
function summarize(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * 转交图片的消费（plan57 K52 B2）：tool 消息上的图片块只出示一轮 ——
 * 下一轮请求发出后即摘掉，不让 base64 在历史里每轮重放（Kiro 事故：整段会话被一张图卡死）。
 * 返回摘掉的块数（单测钉）。幂等：没有可摘的返回 0。
 */
export function stripForwardedImageParts(messages: AgentMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'tool' || !m.parts) continue
    const keep = m.parts.filter((p) => p.type !== 'image' && p.type !== 'video')
    n += m.parts.length - keep.length
    if (keep.length === 0) delete m.parts
    else m.parts = keep
  }
  return n
}

/**
 * 可信读取批资格（S3-40B）：只有**同一个真实内建 read_file 对象**、且每个调用的 canonical key
 * 都唯一可解析时才成立。同名不同对象、键重复、realpath 未知 —— 一律回 null 走原串行路径。
 * ⚠️ 不信工具名或 `readOnly` 自述；身份由 file-tools 的 WeakSet 登记。
 */
export async function planTrustedReadBatch(
  calls: ToolCall[],
  toolMap: Map<string, AgentTool>
): Promise<{ capability: TrustedReadCapability; keys: string[] } | null> {
  if (calls.length < 2) return null
  // 调用 id 必须唯一：重复 id 无法把结果/事件配对回原调用，保守串行
  if (new Set(calls.map((tc) => tc.id)).size !== calls.length) return null
  const first = toolMap.get(calls[0]!.name)
  if (!first || !isTrustedReadTool(first) || !first.trustedRead) return null
  for (const tc of calls) {
    if (toolMap.get(tc.name) !== first) return null
  }
  const capability = first.trustedRead
  const keys = await Promise.all(calls.map((tc) => capability.canonicalKey(parseArgs(tc.arguments))))
  if (keys.some((key) => key === null)) return null
  if (new Set(keys).size !== keys.length) return null
  return { capability, keys: keys as string[] }
}

/** 主循环的日志器（§七④：像"前缀缓存失效"这类**值得但必须知情**的代价要留痕） */
const log = createLogger('agent-loop')

/** E28-R1：异常路径的整轮终态。只读固定事实，不从错误文本猜。 */
function terminalOfError(err: unknown): RunTerminal {
  if (isAbortError(err)) return { state: 'cancelled', code: 'user-stop' }
  if (err instanceof ProviderError && err.facts?.terminal) return err.facts.terminal
  if (err instanceof AgentRunFailure && err.facts?.terminal) return err.facts.terminal
  return { state: 'unknown' }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 12)
  const toolMap = new Map(opts.tools.map((t) => [t.schema.name, t]))
  const messages: AgentMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    // 空正文的助手轮（被中断那一轮留下的）在这里整形，**不带着空串出境**（见 context `historyForModel`）
    ...historyForModel(opts.history)
  ]

  const emitText = (delta: string): void => opts.onText?.(delta)

  let lastText = ''
  let rounds = 0
  /**
   * 省 token 档位（§七②）：不给就是平衡档。
   *
   * ⚠️ `toolWindow: false` **压过**档位 —— 两者不是一回事：那是校准脚本要的"**这一轮**强行原样"
   * （一次实验），档位是"**用户长期**要不要省"（一个偏好）；混成一个就说不清"为什么没压"。
   */
  const policy = opts.policy ?? resolvePolicy(DEFAULT_TOKEN_TIER)
  /** 窗口化总开关：档位说关就关（土豪档），或被校准时强行关掉 */
  const windowEnabled = opts.toolWindow === false ? false : policy.windowEnabled
  /** 这一轮靠窗口化省下的估算 token（plan8 R9.1 记账用） */
  let avoidedTokens = 0

  // ── 执行事件流（plan26 D-077）：run_start / run_end（finally 补发，error 路径不丢）──
  const startedAt = Date.now()
  opts.execEvents?.record('run_start', opts.agentLabel ? { agentName: opts.agentLabel } : undefined)
  let stopReason: AgentLoopResult['stopReason'] | undefined
  // E28-R1：整轮终态 —— 正常返回取 result.terminal，异常取固定 facts；旧路径仍可为 undefined。
  let roundTerminal: RunTerminal | undefined

  try {
    const result = await runRounds()
    roundTerminal = result.terminal
    return result
  } catch (err) {
    roundTerminal = terminalOfError(err)
    if (err && typeof err === 'object' && avoidedTokens > 0) {
      ;(err as Record<string, unknown>).avoidedTokens = avoidedTokens
    }
    throw err
  } finally {
    // plan57 K52 B2：异常中断也摘（中途挂掉的转交图不留 base64 在内存历史里；纯数组操作，不抛）
    stripForwardedImageParts(messages)
    // 异常中断时不带 stopReason（AgentStopReason 只有正常两态，不为此扩共享契约）
    opts.execEvents?.record('run_end', {
      rounds,
      durationMs: Date.now() - startedAt,
      ...(stopReason ? { stopReason } : {}),
      ...(roundTerminal ? { terminal: roundTerminal } : {})
    })
  }

  async function runRounds(): Promise<AgentLoopResult> {
  for (;;) {
    opts.signal?.throwIfAborted()
    if (rounds >= maxRounds) {
      stopReason = 'max-rounds'
      return {
        output: lastText,
        rounds,
        stopReason: 'max-rounds',
        avoidedTokens,
        terminal: { state: 'max-rounds', code: 'token-limit' }
      }
    }
    rounds++

    // 每轮调用模型前按需裁剪（只有给了 contextWindow 才启用）
    const trimOpts: TrimOptions | null = opts.contextWindow ? { contextWindow: opts.contextWindow } : null
    let sent = messages
    if (trimOpts) {
      let trim = trimMessages(messages, trimOpts)
      /**
       * ⚠️ **前缀稳定的已知破坏点**（plan8 R9.1 §七④）：折叠会在**中间**插一条「[历史摘要]」，
       * 而前缀缓存要求"开头一模一样" —— 从摘要往后**缓存全部失效**（本轮输入 token 明显偏高）。
       * 这是**值得的代价**（不折叠就撞上下文上限、整轮作废），但必须是**知情的代价**，故在此留痕。
       * plan26 D-080：滚动摘要 —— 裁剪发生时对被裁段调一次模型（fail-soft：失败退机械占位）。
       */
      let summarized = false
      if (trim.trimmed && opts.summarize) {
        try {
          const text = await opts.summarize(trim.dropped)
          if (text && text.trim().length > 0) {
            // 用模型摘要重新裁剪（同一份逻辑，只换摘要文本）——确定性仍然由 trimMessages 保证
            trim = trimMessages(messages, { ...trimOpts, summaryText: text })
            summarized = true
          }
        } catch (err) {
          if (opts.signal?.aborted || isAbortError(err)) throw err
          // 摘要失败不阻塞主链路（fail-soft）—— 机械占位就是兜底
          log.warn('滚动摘要生成失败，本轮退回机械占位', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      sent = trim.messages
      if (trim.trimmed) {
        log.info('历史已折叠：前缀缓存将从摘要处失效', { 折叠条数: trim.droppedCount, 轮次: rounds })
        opts.execEvents?.record('trim', {
          droppedCount: trim.droppedCount,
          bytes: trim.droppedBytes,
          summarized
        })
      }
    }

    opts.signal?.throwIfAborted()
    const res = await opts.chat(sent, emitText)
    opts.signal?.throwIfAborted()
    if (res.text) lastText = res.text
    // plan57 K52 B2：本轮请求已把转交图片发出 → 摘掉，不让 base64 在后续轮次里重放
    stripForwardedImageParts(messages)

    // 没有工具调用 = 模型认为任务完成，文本即最终交付
    if (res.toolCalls.length === 0) {
      stopReason = 'completed'
      return {
        output: res.text ?? '',
        rounds,
        stopReason: 'completed',
        avoidedTokens,
        terminal: { state: 'completed' }
      }
    }

    // 回灌 assistant（含 tool_calls），再逐个执行并把结果以 tool 角色回灌
    messages.push({
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))
    })

    // 可信内建读取批（S3-40B → S89-01）：本地并行默认开启，整批合格才走"私有暂存 → 同门提交"；
    // 混合读写、同名冒充与同文件别名不产生 readPlan，继续走下面的原串行路径。
    const batchEligible = opts.requestPolicy?.maxLocalReadConcurrency === 2
    const readPlan =
      batchEligible && opts.signal?.aborted !== true ? await planTrustedReadBatch(res.toolCalls, toolMap) : null
    let stagedReads: Map<string, StagedToolRead> | null = null
    let batchStartedAt = 0
    if (readPlan) {
      // start 事件在真实读取前按原序发出；结果回灌仍按原序（见下方 stagedReads）
      for (const tc of res.toolCalls) {
        opts.onToolEvent?.({
          id: tc.id,
          name: tc.name,
          phase: 'start',
          detail: toolCallDetail(tc.name, tc.arguments)
        })
        opts.execEvents?.record('tool_call', { tool: tc.name })
      }
      batchStartedAt = Date.now()
      const batch = await runToolBatch<ToolCall, StagedToolRead>({
        items: res.toolCalls,
        eligible: readPlan !== null,
        signal: opts.signal,
        leasePhase: 'tool:read_file',
        canStart: (tc) => (opts.canStart ? opts.canStart(tc.name) === true : true),
        run: (tc) =>
          readPlan.capability.stage(
            parseArgs(tc.arguments),
            opts.signal,
            opts.canStart ? () => opts.canStart!(tc.name) === true : undefined
          ),
        guard: (results) =>
          opts.signal?.aborted !== true &&
          // 未启动项与 blocked 同义：整批不得提交，避免只落已成功项的读资格
          results.every((r) => r.started) &&
          results.every((r) => r.value?.blocked !== true) &&
          (opts.canCommit
            ? opts.canCommit() === true
            : opts.canStart
              ? opts.canStart('read_file') === true
              : true),
        commit: (results) => {
          for (const r of results) {
            if (r.started && r.status === 'fulfilled' && r.value && r.value.blocked !== true) {
              readPlan.capability.commit(r.value)
            }
          }
        },
        discard: (results) => {
          for (const r of results) if (r.value) readPlan.capability.discard(r.value)
        }
      })
      // 未启动（guard 拒绝/排队未轮到）或 blocked 与取消同义：整批不提交，run 暂停
      if (batch.aborted || batch.results.some((r) => !r.started || r.value?.blocked === true)) {
        // start 已按原序发出：先补终态，保证 ToolEvent.id 成对，再中止本轮
        for (const tc of res.toolCalls) {
          opts.onToolEvent?.({
            id: tc.id,
            name: tc.name,
            phase: 'error',
            summary: '本批读取未提交（取消或权限守卫失效）',
            outcome: 'cancelled'
          })
        }
        opts.signal?.throwIfAborted()
        throw new AgentPauseError('本批读取未提交：run 已取消或权限守卫失效')
      }
      opts.signal?.throwIfAborted()
      stagedReads = new Map()
      for (const r of batch.results) {
        const staged: StagedToolRead =
          r.value ?? {
            text: `错误：读取失败——${r.error instanceof Error ? r.error.message : String(r.error)}`,
            ok: false,
            receipt: null,
            key: null
          }
        stagedReads.set(r.item.id, staged)
      }
    }

    for (const tc of res.toolCalls) {
      const stagedRead = stagedReads?.get(tc.id)
      if (stagedReads && !stagedRead) {
        throw new AgentPauseError('批读取结果缺失：拒绝回退到二次执行')
      }
      opts.signal?.throwIfAborted()
      const tool = toolMap.get(tc.name)
      // 带上「这一步在干什么」（从入参提取），否则界面只能显示干巴巴的「执行中…」
      let artifactPaths: string[] = []
      if (!stagedRead) {
        opts.onToolEvent?.({
          id: tc.id,
          name: tc.name,
          phase: 'start',
          detail: toolCallDetail(tc.name, tc.arguments)
        })
        // plan26 D-077：tool_call 只记工具名 —— **入参不进事件流**（content 类参数即文件正文）
        opts.execEvents?.record('tool_call', { tool: tc.name })
      }

      const toolStartedAt = stagedRead ? batchStartedAt : Date.now()
      let toolImages: ToolImageRef[] = []
      // plan57 K52 B2：本工具调用要交给模型的图片块（opt-in，默认空；挂到本条 tool 消息的 parts 上）
      let forwarded: Array<{ type: 'image'; mime: string; base64: string; ref: string }> = []
      // 看门狗标记（plan37 S0）：save/restore 回前值 —— 单槽阶段硬写 'idle' 会抹平并发路径（见 watchdog.ts）。
      // 批路径的读取阶段由 tool-batch 租约持有，这里不再重复占用旧槽。
      const prevPhase = stagedRead ? null : setWatchdogPhase(`tool:${tc.name}`)
      let output: string
      let outcomeState: ToolOutcome['outcome']
      let outcomeCode: ToolOutcome['code']
      let outcomeExitCode: ToolOutcome['exitCode']
      try {
        if (!tool) {
          output = `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join('、') || '（无）'}`
          outcomeState = 'failed'
          outcomeCode = 'tool-error'
        } else if (stagedRead) {
          // 真实读取与版本已在批路径完成；这里只回灌已提交文本，不再执行第二次
          output = stagedRead.text
        } else {
          try {
            opts.signal?.throwIfAborted()
            // 串行路径同样在真实启动前核一次：C 接真实权限代次时不需另开分支
            let allowed = true
            try {
              allowed = opts.canStart ? opts.canStart(tc.name) === true : true
            } catch {
              allowed = false
            }
            if (!allowed) throw new AgentPauseError('工具启动前权限守卫失效')
            const args = parseArgs(tc.arguments)
            const raw = await tool.execute(args)
            opts.signal?.throwIfAborted()
            // 工具可以只回文本（绝大多数），也可以回"文本 + 图片引用"（plan44 S2b）。
            // 归一化只在这一处发生：**进模型的一直是 text**，images 只交给界面事件。
            const outcome = typeof raw === 'string' ? { text: raw } : raw
            output = outcome.text
            outcomeState = outcome.outcome
            outcomeCode = outcome.code
            outcomeExitCode = outcome.exitCode
            // 工具确认实际落盘后才消费；入参或模型文字不能提前生成“已产出”卡。
            artifactPaths = (tool.takeProducedFiles?.(args) ?? []).flatMap(path => toolArtifactPaths(tc.name, JSON.stringify({ path })))
            toolImages = outcome.images ?? []
            // plan57 K52 B2：opt-in 交图 —— 只有显式要交的工具才挂 parts 进模型（MCP 等老工具不受影响）
            forwarded =
              'forwardImagesToModel' in outcome
                ? (outcome.forwardImagesToModel ?? []).map((f) => ({
                    type: 'image' as const,
                    mime: f.mime,
                    base64: f.base64,
                    ref: f.ref
                  }))
                : []
          } catch (err) {
            if (opts.signal?.aborted || isAbortError(err) || err instanceof AgentPauseError) throw err
            output = `错误：工具执行异常——${err instanceof Error ? err.message : String(err)}`
            outcomeState = 'failed'
            outcomeCode = 'tool-error'
          }
        }
      } finally {
        if (prevPhase !== null) setWatchdogPhase(prevPhase)
      }

      // 窗口化（plan8 R9.1）：留头尾 + 中段按行号采样 + 报错现场保护；双门控不过就原样放行
      let saved = 0
      if (windowEnabled && !SELF_MANAGED_TOOLS.has(tc.name)) {
        // 窗口化是纯同步全量处理（大输出可达数百 KB），单独打阶段标记（plan37 S0）+ 同步块插桩
        // （plan49 A 档：这是全仓唯一被自己注释标出来的重同步块，不给它记账就说不过去）
        const prevWinPhase = setWatchdogPhase(`windowing:${tc.name}`)
        try {
          // 档位（§七②）只调**三个数**：进判断的门槛、相对门、绝对预算 ——
          // 头尾行数、采样条数不随档位变，三条红线（不静默 / 不压报错现场 / 不伪造）正挂在它们上。
          const w = traceSync(`windowing:${tc.name}`, () =>
            windowToolOutput(output, {
              toolName: tc.name,
              minBytes: policy.minBytes,
              keepRatioMax: policy.keepRatioMax,
              maxTokens: policy.maxTokens
            })
          )
          // **静默是禁止的**：每次成形都要留痕（界面 + 主进程日志两处）。
          // `small` = 压根没进判断，报它等于刷日志
          if (w.reason !== 'small') {
            opts.onToolWindowed?.({
              name: tc.name,
              beforeTokens: w.beforeTokens,
              afterTokens: w.afterTokens,
              reason: w.reason
            })
          }
          if (w.compressed) {
            saved = w.beforeTokens - w.afterTokens
            avoidedTokens += saved
            output = w.text
          }
        } finally {
          setWatchdogPhase(prevWinPhase)
        }
      }

      const failed = outcomeState !== undefined
        ? outcomeState !== 'succeeded'
        : output.startsWith('错误')

      const finalOutcome = outcomeState ?? (failed ? 'failed' : 'succeeded')

      opts.onToolEvent?.({
        id: tc.id,
        name: tc.name,
        phase: failed ? 'error' : 'end',
        summary: summarize(output),
        ...(saved > 0 ? { savedTokens: saved } : {}),
        ...(toolImages.length > 0 ? { images: toolImages } : {}),
        ...(!failed && artifactPaths.length > 0 ? { artifactPaths } : {}),
        outcome: finalOutcome,
        ...(outcomeCode ? { code: outcomeCode } : {}),
        ...(outcomeExitCode !== undefined ? { exitCode: outcomeExitCode } : {})
      })
      // plan26 D-077：tool_result 只记元数据 —— bytes 是输出大小、**正文不进事件流**
      // E28-R1：传真实 ToolResult 事实；没有 outcome 的旧工具不补，不从文本猜状态。
      opts.execEvents?.record('tool_result', {
        tool: tc.name,
        ok: !failed,
        ms: Date.now() - toolStartedAt,
        bytes: Buffer.byteLength(output, 'utf8'),
        windowed: saved > 0,
        ...(outcomeState ? { outcome: outcomeState } : {}),
        ...(outcomeCode ? { code: outcomeCode } : {}),
        ...(outcomeExitCode !== undefined ? { exitCode: outcomeExitCode } : {})
      })

      // 注入边界标记：工具产出（文件内容/网页/命令输出）一律是**数据**，不是指令
      // plan57 K52 B2：opt-in 交图 —— forwarded 非空才挂 parts（MCP 等老工具不受影响）；
      // parts 随下轮请求出境一次，出境后由 strip 摘掉（见 chat 成功后），不摘就会每轮重放。
      messages.push({
        role: 'tool',
        content: `<tool_output name="${tc.name}">\n${output}\n</tool_output>`,
        tool_call_id: tc.id,
        ...(forwarded.length > 0 ? { parts: forwarded } : {})
      })
    }
  }
  }
}
