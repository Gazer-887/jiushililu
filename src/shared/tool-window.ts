/**
 * 工具输出窗口化（plan8 R9.1）—— **纯逻辑**：不 import electron、不碰 IO、不认识网络。
 * 产出「带原始行号的省略视图」而不是砍一刀：模型能按行号精确取回，而不是看天书。
 * ⚠️ **截断不是错、瞒着截断才是错**：模型会把"我看到的"当成"全部就是这样"然后给出错结论；也不许只留开头 —— 错误与摘要在**末尾**（`run_command` 早期版本只保留前 8000 字符，正好砍掉排错现场）。
 * ⚠️ 固定的头尾行数 + 比例字节门 = 中等长度输出**必然压不动**、且**静默省不到**（比不压缩更坏）—— 修法见 `SCALES` 的自适应收紧。
 * ⚠️ `reason` 不许把两道门合成一个 'not-worse'：那样"删掉 token 闸"的变异测试**照样全绿**（断言必须能被证伪）。
 * 阈值取保守值（借 `dsh-plugin-save-token` 的 A/B 实测）：激进压缩成本反而更高，宁可少压一点。
 */

import { estimateTokens } from './tokens'

export interface ToolWindowOptions {
  /** 小于它不处理 */
  minBytes?: number
  /** 含报错特征时抬高门槛 —— 少动排错现场 */
  errorMinBytes?: number
  /** 字节门：压后不得超过原始的这个比例 */
  keepRatioMax?: number
  headLines?: number
  tailLines?: number
  strideSamples?: number
  maxLineChars?: number
  /** 报错命中行最多留多少条（其上下文另算） */
  maxErrorLines?: number
  /** 接了落盘取回工具时由调用方传入；不给就按工具名生成"怎么续读"的处方 */
  retrievalHint?: string
  /** 用来生成**具体**的续读处方 —— 别让模型自己猜重试参数 */
  toolName?: string
  /**
   * **绝对预算**（估算 token）：压完不许超过这个量。
   * ⚠️ 光有相对门不够 —— 相对门只管"比原来小"，MB 级原始文本压完仍能撑爆上下文，发给厂商只会得到"超出上下文"的报错、**整轮作废**。
   */
  maxTokens?: number
}

export type WindowReason = 'small' | 'compressed' | 'byte-gate' | 'token-invariant'

export interface ToolWindowResult {
  /** 没处理时**就是原文**，一个字都没动 */
  text: string
  compressed: boolean
  beforeBytes: number
  afterBytes: number
  beforeTokens: number
  afterTokens: number
  /** 各道门**分开报** —— 合起来写就没法断言"哪道门起了作用" */
  reason: WindowReason
  /** 小于 1 = 为了过门把窗口收小了 */
  scale: number
}

/** 行窗口的"地图"（纯索引，便于单测直接断言索引集合而不去读排版） */
export interface WindowPlan {
  headEnd: number
  tailStart: number
  /** 中段里**报错相关及其上下文**的原始行下标（升序、去重） */
  errorIdx: number[]
  /** 中段**命中报错特征的总行数**（可能大于 `errorIdx` 覆盖的条数 —— 文案要如实说） */
  hitCount: number
  /** 中段采样的原始行下标（升序） */
  sampleIdx: number[]
  stride: number
}

/**
 * 报错特征。**中英都要**：中文错误文本是本项目自己写的，而工具输出里还混着 npm / tsc / git 的英文报错 —— 只认英文等于漏掉一半现场。
 * ⚠️ 这份清单是被红队审查拿真实报错样例逐条打出来的：漏一个就等于"排错现场少一块"。
 */
const ERROR_RE =
  /error|fatal|traceback|exception|panic|timeout|failed|failure|warning|✗|✘|✕|错误|失败|异常|报错|不通过|警告|超时|堆栈|栈追踪|npm ERR|EACCES|EPERM|ENOENT|ERR_[A-Z]|exit code [1-9]|not ok|TS\d{4}|--- FAIL|Expected|Received/i

/**
 * **栈帧行**（JS/Java 的 `  at foo (file:12:3)`、rustc 的 `-->`、Python 的 `  File "x.py"`、Java 的 `Caused by:`、tsc 的波浪线行）。
 * ⚠️ 单列一条是因为这些行**本身不含"error"这个词**：只按关键词抓会得到"留下了 `Error: xxx`、帧全被压掉"的结果 —— 而那正是排错最需要的。
 */
const FRAME_RE = /^\s*at\s+\S|^\s*-->|^\s*File "|Caused by:|^\s*[~^]{3,}\s*$/

/**
 * **按工具给"怎么续读"的处方**（不要只说"已截断"）—— 别让模型自己猜重试参数；⚠️ 措辞写成命令式且放前面会让模型**抢先重跑**，故一律以「只有……才」开头、放在最后。
 * ⚠️ **不许按"输出形态"分流**（试过、实测有害、已回滚，plan8 R9.2）：同一个 harness、同一条任务各跑 5 次，通用处方工具调用中位 4 次，分流版中位 9 次 —— 两组不相交，不是噪声是退化。
 */
function defaultHintFor(toolName: string | undefined): string {
  switch (toolName) {
    case 'run_command':
      return '只有确认你要的东西**在中段被省略的过程输出里**时，才重取 —— 且**不要原样重跑**：收窄输出（加 grep/findstr 过滤、`| tail -n 100`、或 --quiet 之类）。'
    case 'fetch_url':
      return '只有确认你要的内容**在中段**时，才换更窄的请求（带 #锚点、或抓具体子页面）重取。'
    case 'spawn_subagent':
      return '只有确认子代理的关键结论**在中段**时，才让它把结论写在报告开头、或写进文件再按行读。'
    default:
      return toolName === 'read_file'
        ? '只有确认你要的行**在中段**时，才用 `read_file` 的 `offset` 按行区间精确读取。'
        : '只有确认你要的内容**在中段**时，才用更窄的查询重取；不要原样重试。'
  }
}

const isErrorishLine = (line: string): boolean => ERROR_RE.test(line) || FRAME_RE.test(line)

const DEFAULTS = {
  minBytes: 1400,
  errorMinBytes: 6000,
  keepRatioMax: 0.72,
  headLines: 60,
  tailLines: 40,
  strideSamples: 50,
  maxLineChars: 420,
  maxErrorLines: 25,
  maxTokens: 8000
} as const

/**
 * 收紧档位：从"不收紧"开始**逐档按比例缩小窗口**直到过门；收紧的只是"保留多少行 / 抽多少样本"，**结构不变**（照样头、尾、采样、报错块）。
 */
const SCALES = [1, 0.5, 0.25, 0.1] as const

/** UTF-8 字节数（不依赖 Buffer，渲染进程也能用同一份逻辑） */
function utf8Bytes(text: string): number {
  // 快路径：全是 ASCII 时长度就是字节数
  let ascii = true
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return text.length
  return new TextEncoder().encode(text).length
}

/** 掐断超长单行（压缩产物一行可达数万字符，"限制行数"挡不住它） */
function clipLine(line: string, max: number): string {
  if (line.length <= max) return line
  const drop = line.length - max
  return `${line.slice(0, max)}…[本行还有 ${drop} 字符未显示]`
}

/**
 * 算出行窗口的"地图"（纯索引，不拼字符串）：采样行**带原始行号**，头尾**原样**；⚠️ 行号前缀只许出现在"本来就是省略视图"的地方 —— 前缀混进原文会被模型照抄成文件内容。
 */
export function planWindow(
  lines: string[],
  opts: Required<Omit<ToolWindowOptions, 'retrievalHint' | 'toolName'>> & { scale: number }
): WindowPlan {
  const headEnd = Math.min(lines.length, Math.max(1, Math.round(opts.headLines * opts.scale)))
  const tailLen = Math.max(0, Math.round(opts.tailLines * opts.scale))
  const tailStart = Math.max(headEnd, lines.length - tailLen)

  const middleFrom = headEnd
  const middleTo = tailStart
  const middleLen = Math.max(0, middleTo - middleFrom)

  const errorIdx: number[] = []
  let hitCount = 0
  if (middleLen > 0) {
    const hits: number[] = []
    for (let i = middleFrom; i < middleTo; i++) {
      if (isErrorishLine(lines[i]!)) hits.push(i)
    }
    hitCount = hits.length
    if (hits.length > 0) {
      // **取两端，不取前端**：构建/测试日志的**根因常常在最后一条**（前面全是级联失败），
      // 最开始那几条只是"第一次出错的现场" —— 只留前面正好把结论丢掉（红队审查点名过）。
      const headKeep = Math.ceil(opts.maxErrorLines / 3)
      const tailKeep = Math.max(0, opts.maxErrorLines - headKeep)
      const chosen = hits.length <= opts.maxErrorLines ? hits : [...hits.slice(0, headKeep), ...hits.slice(-tailKeep)]
      const keep = new Set<number>()
      for (const i of chosen)
        for (let d = -1; d <= 2; d++) if (i + d >= middleFrom && i + d < middleTo) keep.add(i + d)
      errorIdx.push(...[...keep].sort((a, b) => a - b))
    }
  }

  const strideSamples = Math.max(1, Math.round(opts.strideSamples * opts.scale))
  const stride = middleLen > 0 ? Math.max(1, Math.ceil(middleLen / strideSamples)) : 1
  const sampleIdx: number[] = []
  for (let i = middleFrom; i < middleTo; i += stride) sampleIdx.push(i)

  return { headEnd, tailStart, errorIdx, sampleIdx, stride, hitCount }
}

/** 按地图拼出候选文本 */
function renderWindow(
  lines: string[],
  plan: WindowPlan,
  o: { maxLineChars: number; retrievalHint: string },
  beforeBytes: number,
  beforeTokens: number
): string {
  // ⚠️ 掐断必须**逐行**做：对整块 join 后的文本掐一次 = 把"保留头部"变成"只保留第一行的一截"（头几十行里只剩第一行的前 maxLineChars 字符）
  const clipBlock = (ls: string[]): string => ls.map((l) => clipLine(l, o.maxLineChars)).join('\n')

  const parts: string[] = [clipBlock(lines.slice(0, plan.headEnd))]
  const middleLen = Math.max(0, plan.tailStart - plan.headEnd)

  if (middleLen > 0) {
    if (plan.errorIdx.length > 0) {
      const rows: string[] = []
      let prev = -1
      for (const i of plan.errorIdx) {
        if (prev >= 0 && i > prev + 1) rows.push('（…）') // 断档处明说"这里跳过了几行"
        rows.push(`${i + 1}|${clipLine(lines[i]!, o.maxLineChars)}`)
        prev = i
      }
      parts.push(
        `—— 中段共 ${middleLen} 行；**报错相关命中 ${plan.hitCount} 行**，` +
          `此处列出${
            plan.hitCount > plan.errorIdx.length
              ? `最早与最后的若干条及其上下文（不是全部 —— 其余请按行号取回）`
              : '全部（含上下文）'
          }，行号为原文行号 ——\n${rows.join('\n')}`
      )
    }
    parts.push(
      `—— 中段其余内容**按每 ${plan.stride} 行抽 1 行**取样（行号为原文行号，可据此精确取回）：\n${plan.sampleIdx
        .map((i) => `${i + 1}|${clipLine(lines[i]!, o.maxLineChars)}`)
        .join('\n')}`
    )
  }

  if (plan.tailStart < lines.length) {
    const tailLen = lines.length - plan.tailStart
    parts.push(`—— 以下是**末尾 ${tailLen} 行**全文 ——\n${clipBlock(lines.slice(plan.tailStart))}`)
  }

  // ⚠️ 措辞是**被真机 A/B 打回来的**：早先写"需要被省略部分时，请重新执行更精确的命令"，
  //    结果在"从命令输出找结论"那条任务上**开着压缩反而多花一倍 token**（那句话把模型诱导去重跑命令），多出的回合把整个上下文重复计费 —— 故现在的措辞：先声明头尾完整、先说"答案多半就在保留区里"、"怎么重取"降级成**条件句**。
  const keptHead = plan.headEnd
  const keptTail = lines.length - plan.tailStart
  const errNote =
    plan.errorIdx.length > 0 ? ` **报错相关命中 ${plan.hitCount} 行已单独列出**。` : ''
  const head =
    `[工具输出过长，已压缩展示] 原文 ${beforeBytes} 字节 / 约 ${beforeTokens} token。` +
    `**开头 ${keptHead} 行 + 末尾 ${keptTail} 行是未改动的原文**（逐字节原样；只省略了中段，省略处标了原文行号）。${errNote}` +
    // ⚠️ 实测：模型第 1 次就拿到了含结论的完整输出，却仍不信"被压过的输出"，用 `search_files` / `read_file` / `tail` **换着法子反复确认** —— 白烧轮次。
    //    故把两件事说死：① 保留区是**逐字节原文**、不是转述；② **不要为了"确认"再跑一遍或改读别的文件**。
    `**保留区每一行都是未改动的原文**（逐字节原样，不是转述）。` +
    `结论/报错/退出码就在里面：**先读完再决定下一步**，不要为了"确认"再跑一遍、或改读别的文件。${o.retrievalHint}\n`
  return `${head}${parts.join('\n\n')}`
}

/** 把一段工具输出切成"带坐标的地图"，并在门的约束下决定用不用它 */
export function windowToolOutput(raw: string, options: ToolWindowOptions = {}): ToolWindowResult {
  const o = { ...DEFAULTS, ...options }
  const text = raw.replace(/\r\n/g, '\n')
  const beforeBytes = utf8Bytes(text)
  const beforeTokens = estimateTokens(text)

  const unchanged = (reason: 'small' | 'byte-gate' | 'token-invariant'): ToolWindowResult => ({
    text: raw,
    compressed: false,
    beforeBytes,
    afterBytes: beforeBytes,
    beforeTokens,
    afterTokens: beforeTokens,
    reason,
    scale: 1
  })

  const lines = text.split('\n')
  const isErrorish = lines.some(isErrorishLine)
  const threshold = isErrorish ? o.errorMinBytes : o.minBytes
  if (beforeBytes < threshold) return unchanged('small')

  const hint = o.retrievalHint ?? defaultHintFor(o.toolName)
  const budget = beforeBytes * o.keepRatioMax

  // 逐档收紧，取**第一个同时过三道约束**的候选：① 相对字节门（≤ keepRatioMax）
  // ② 绝对预算（≤ maxTokens）③ token 不增；全都不行才算过不了门 —— 报哪一道要看最紧档的实情。
  let lastTightest: { text: string; tokens: number } | null = null
  for (const scale of SCALES) {
    const map = planWindow(lines, { ...o, scale })
    const candidate = renderWindow(
      lines,
      map,
      { maxLineChars: o.maxLineChars, retrievalHint: hint },
      beforeBytes,
      beforeTokens
    )
    const candBytes = utf8Bytes(candidate)
    const candTokens = estimateTokens(candidate)
    if (scale === SCALES[SCALES.length - 1]) lastTightest = { text: candidate, tokens: candTokens }

    if (candBytes > budget) continue
    if (candTokens > o.maxTokens) continue
    // **不变式校验**（不是"第二道门"，别把它想成双保险）：在本项目的估算口径下相对字节门**已经蕴含**它 —— 估算 token 密度上下限之比 ≤ 1.33，
    // 而字节门要求压到 0.72 倍（0.72 × 1.33 = 0.96 < 1），故"过了字节门"必然"token 也降了"；留着它是因为**口径是会变的**（换真分词器、或有人把 keepRatioMax 调到 0.9），
    // 越过那点余量后"更小字节换更大 token"就会真发生 —— 一句便宜的断言：不成立就当没压过。
    if (candTokens >= beforeTokens) continue

    return {
      text: candidate,
      compressed: true,
      beforeBytes,
      afterBytes: candBytes,
      beforeTokens,
      afterTokens: candTokens,
      reason: 'compressed',
      scale
    }
  }

  // 走到这里说明没有一档能过门。报哪一道：看**最紧档**的实情 —— 过不了绝对预算、或过了绝对预算但过不了相对门 → byte-gate；连 token 都没降 → token-invariant。
  if (!lastTightest) return unchanged('byte-gate')
  if (lastTightest.tokens > o.maxTokens) return unchanged('byte-gate')
  if (utf8Bytes(lastTightest.text) > budget) return unchanged('byte-gate')
  return unchanged('token-invariant')
}
