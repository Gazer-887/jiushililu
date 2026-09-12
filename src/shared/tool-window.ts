/**
 * 工具输出窗口化（plan8 R9.1）—— **纯逻辑**：不 import electron、不碰 IO、不认识网络。
 *
 * ## 为什么要有它
 *
 * Agent 的成本大头是**反复进入上下文的工具输出**：一次命令输出、一次网页正文、一份日志。
 * 但"省 token"最忌讳两件事，本项目两条都踩过：
 *
 * 1. **盲目砍一刀**：`run_command` 以前只保留**前 8000 字符** —— 而错误与摘要在**末尾**，
 *    于是"输出太长"时用户看到的永远是没有结论的那半截（排错现场被砍掉，最要命）。
 * 2. **不说被砍了**：模型把"我看到的"当成"全部就是这样"，然后给出错结论。
 *    截断**不是错**，**瞒着截断**才是错。
 *
 * ## 借来的做法（`dsh-plugin-save-token`，本机可读，有 A/B 实测）
 *
 * - **结构感知优先**：头全量 + 尾全量 + 中段**按原始行号步进采样**
 *   —— 模型拿到"带坐标的地图"，能按行号精确取回，而不是"看天书"
 * - **错误行保护**：命中报错特征的行**连同上下文**强制保留（排错现场不许被压掉）
 * - **双门控（never-worse）**：候选必须**同时**满足 ① 字节 ≤ 原始 × `keepRatioMax`
 *   ② 估算 token **严格下降**；任一条不过就**原样放行**
 * - **保守阈值**：它引的 RCT 数据显示激进压缩（保留率 0.2）成本**反而 +1.8%**，
 *   0.5 才省 27.9% —— 所以我们宁可少压一点，也不赌
 *
 * ## 本项目自己撞出来的两条（2026-09-12 独立审查提出，已修）
 *
 * - **固定的头尾行数 + 比例字节门 = 中等长度输出永远压不动**：
 *   60+40+50 是常数，而门是"压到 72% 以下" —— 于是**行数 ≲230 的输出一定不过门**
 *   （200 行 × 20 汉字 ≈ 12KB，保留 150 行 ≈ 10KB > 72%）。结果是**静默地省不到**，
 *   比不压缩更坏（因为看起来"功能做了"）。修法：**按预算自适应**收紧窗口（见 `SCALES`）。
 * - **`reason` 不许把两道门合成一个 'not-worse'**：那样"删掉 token 闸"的变异测试**照样全绿**
 *   （本项目铁律：断言必须能被证伪）。所以拆成 `'byte-gate'` / `'token-gate'`。
 */

import { estimateTokens } from './tokens'

export interface ToolWindowOptions {
  /** 小于这个字节数不处理（默认 1400） */
  minBytes?: number
  /** 输出里含报错特征时，门槛抬高到它（默认 6000）—— 少动排错现场 */
  errorMinBytes?: number
  /** 字节门：压缩后不得超过原始的这个比例（默认 0.72） */
  keepRatioMax?: number
  /** 头部原样保留多少行（默认 60） */
  headLines?: number
  /** 尾部原样保留多少行（默认 40） */
  tailLines?: number
  /** 中段最多抽多少条样本（默认 50，实际步长按中段行数算） */
  strideSamples?: number
  /** 单行超过这个长度就掐断（默认 420） */
  maxLineChars?: number
  /** 报错命中行最多保留多少条（默认 25，其上下文另算） */
  maxErrorLines?: number
  /** 取回提示（接了落盘取回工具时由调用方传入；不给就按工具名生成"怎么续读"的处方） */
  retrievalHint?: string
  /** 是哪个工具产出的（用来生成**具体**的续读处方 —— 别让模型自己猜重试参数） */
  toolName?: string
  /**
   * **绝对预算**（估算 token，默认 8000）：压完不许超过这个量。
   *
   * 为什么光有"压到 72% 以下"这道相对门不够（2026-09-12 红队审查抓出来的洞）：
   * 相对门只管"比原来小"，3MB 的原始文本压到 2.1MB **也算过门** ——
   * 而 2.1MB ≈ 50 万 token，发给厂商只会得到"超出上下文"的报错、**整轮作废**。
   * 窗口形状本身的地板在 ~2k token 左右（头尾 + 几行采样），所以收紧档一定能满足它。
   */
  maxTokens?: number
}

export type WindowReason = 'small' | 'compressed' | 'byte-gate' | 'token-invariant'

export interface ToolWindowResult {
  /** 处理后的文本（没处理时**就是原文**，一个字都没动） */
  text: string
  compressed: boolean
  beforeBytes: number
  afterBytes: number
  beforeTokens: number
  afterTokens: number
  /**
   * 为什么是这个结果（界面/日志要能说清"它到底压没压、为什么"）。
   * 各道门**分开报** —— 否则"哪道门起了作用"就没法被断言。
   */
  reason: WindowReason
  /** 实际采用的收紧档位（1 = 不收紧；小于 1 = 为了过门把窗口收小了） */
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
  /** 实际步长（每多少行抽 1 行） */
  stride: number
}

/**
 * 报错特征。**中英都要**：本项目的中文错误文本是自己写的（"错误：路径越界"），
 * 而工具输出里还混着 npm / tsc / git 的英文报错 —— 只认英文等于漏掉一半现场。
 *
 * ⚠️ 这份清单是**被红队审查逐条打出来的**（2026-09-12）：他们拿真实报错样例去试，
 * 补进来了编译警告、npm 错误码、退出码、测试框架的失败标记、Python 的 ERR_ 等 ——
 * 这些东西**本来就该在最坏情况下也被留住**，漏一个就等于"排错现场少一块"。
 */
const ERROR_RE =
  /error|fatal|traceback|exception|panic|timeout|failed|failure|warning|✗|✘|✕|错误|失败|异常|报错|不通过|警告|超时|堆栈|栈追踪|npm ERR|EACCES|EPERM|ENOENT|ERR_[A-Z]|exit code [1-9]|not ok|TS\d{4}|--- FAIL|Expected|Received/i

/**
 * **栈帧行**（JS/Java 的 `  at foo (file:12:3)`、rustc 的 `--> src/x.rs:9:5`、
 * Python 的 `  File "x.py", line 9`、Java 的 `Caused by:`、tsc 的波浪线行）。
 *
 * 为什么单独一条：这些行**本身不含"error"这个词** —— 只按关键词抓，会得到
 * "留下了 `Error: xxx`、帧全被压掉"的结果，而那正是排错时最需要的东西
 * （本条是被自己的单测抓出来的：`at Object.<anonymous>` 一个词都不命中）。
 */
const FRAME_RE = /^\s*at\s+\S|^\s*-->|^\s*File "|Caused by:|^\s*[~^]{3,}\s*$/

/**
 * **按工具给"怎么续读"的处方**（不要只说"已截断"）。
 *
 * 业界共识（调研结论 2026-09-12）：只说"被截断了"不够 —— Roo 回的是
 * `Showing only X of Y total lines. Use line range…`，Claude Code 在 PARTIAL 通知里
 * 直接教模型用 offset/limit，v2.1.105 起还**按格式**给处方（JSON 给 jq、文本给算好的分块）。
 * 一句话：**别让模型自己猜重试参数**。
 *
 * ⚠️ 但**措辞的顺序很要命**（实测教训）：处方写在前面、且写成命令式（"请重新执行…"），
 * 模型会**抢先重跑**；改成"条件句 + 放在最后"之后，它才会先看保留区。
 * 所以这里一律以「只有……才」开头。
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
 * 收紧档位：从"不收紧"开始，**逐档把窗口按比例缩小**，直到过字节门。
 *
 * 为什么必须有它：头尾行数是**常数**，而门是**比例** —— 中等长度的输出
 * （行数 ≲230）无论怎么算都过不了 72%，于是整段功能静默失效。
 * 收紧的是"保留多少行"和"抽多少样本"，**结构不变**（照样头、尾、采样、报错块）。
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
 * 算出行窗口的"地图"（纯索引，不拼字符串）。
 * 采样行**带原始行号**，头尾**原样** —— 行号前缀只出现在"本来就是省略视图"的地方，
 * 因为前缀进了原文就是污染（命令输出可能被模型照抄成文件内容）。
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
      // 而最开始那几条是"第一次出错的现场"。只留前 25 条 = 正好把结论丢掉
      // （红队审查点名：文案写着"全部保留"，而丢掉的 675 条里就有最后那条根因）。
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
  // ⚠️ 掐断必须**逐行**做：对整块 join 后的文本掐一次 = 头 60 行里只留前 420 字符，
  //    那是把"保留头部"变成"只保留第一行的一截"（第一版就是这么写错的）。
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

  // ⚠️ 开头这段是**被实测打回来的**（2026-09-12 首次真机 A/B，见 harness）：
  //    原先写的是"需要被省略部分时，请重新执行更精确的命令"——结果在"命令输出找结论"那条任务上，
  //    **开着压缩反而比不开多花一倍 token**（80.2k vs 39.3k）：压缩本身省了 7.7k，但这句话
  //    把模型诱导去**重跑命令 / 再读一遍**，多出来的回合把整个上下文重复计费。
  //    现在的措辞改三件事：① 先声明**头尾是完整的、原样保留的** ② **先说"答案多半就在保留区里"**
  //    ③ 把"怎么重取"降级成**条件句**（只有确认东西在中段里时才用）。
  const keptHead = plan.headEnd
  const keptTail = lines.length - plan.tailStart
  const errNote =
    plan.errorIdx.length > 0 ? ` **报错相关命中 ${plan.hitCount} 行已单独列出**。` : ''
  const head =
    `[工具输出过长，已压缩展示] 原文 ${beforeBytes} 字节 / 约 ${beforeTokens} token。` +
    `**开头 ${keptHead} 行 + 末尾 ${keptTail} 行是未改动的原文**（逐字节原样；只省略了中段，省略处标了原文行号）。${errNote}` +
    // ⚠️ 下面这两句是**2026-09-13 实测校准后补硬的**（第三轮，按工具调用明细定位）：
    //    一条只要求"跑一次命令"的任务，模型跑了 **9 次工具调用** ——
    //    而**第 1 次就已经拿到了完整输出（含结论）**，第 2 次还自己用了收窄处方；
    //    之后它却用 `search_files` / `list_dir` / `read_file` / `tail` **换着法子反复确认**。
    //    → **它不是没看到结论，是不信"被压过的输出"**：想绕开压缩去读原始文件。
    //    所以这里把两件事说死：① 保留区是**逐字节原文**、不是转述；
    //    ② **不要为了"确认"再跑一遍或改去读别的文件** —— 那正是白烧的轮次。
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

  // 逐档收紧，取**第一个同时过三道约束**的候选：
  //   ① 相对字节门（≤ keepRatioMax）② 绝对预算（≤ maxTokens）③ token 不增
  // 全都不行才算过不了门 —— 报哪一道要看最紧档的实情。
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
    // **不变式校验**（不是"第二道门"，别把它想成双保险）：
    //
    // ⚠️ 在本项目的估算口径下，相对字节门**已经蕴含**了这一条 ——
    //    估算的 token 密度上限是汉字 1 token/字符 ÷ 3 字节 ≈ **0.333 token/字节**，
    //    下限是 ASCII 0.25 token/字节，两者之比 ≤ 1.33；而字节门要求压到 0.72 倍 →
    //    0.72 × 1.33 = **0.96 < 1**，所以"过了字节门"必然"token 也降了"。
    //    这一点是被单测逼出来的：我原本写了"双门控"，但**没有任何输入能让 token 那道门开**
    //    —— 一个永远不会执行的判断，和"有防护"在报告里长得一模一样。
    //
    // 那还留着它做什么：**口径是可能变的**（换成真分词器、或有人把 keepRatioMax 调高到 0.9），
    // 一旦变的幅度越过了上面那个 0.96 的余量，"更小的字节数换来更大的 token 数"就会真的发生。
    // 所以这里留一句**便宜的断言**：不成立就当没压过。
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

  // 走到这里说明没有一档能过门。报哪一道：看**最紧档**的实情 ——
  // 过不了绝对预算 → byte-gate（它意味着"连最紧的窗口都还太大"）；
  // 过了绝对预算但过不了相对门 → byte-gate；连 token 都没降 → token-invariant。
  if (!lastTightest) return unchanged('byte-gate')
  if (lastTightest.tokens > o.maxTokens) return unchanged('byte-gate')
  if (utf8Bytes(lastTightest.text) > budget) return unchanged('byte-gate')
  return unchanged('token-invariant')
}
