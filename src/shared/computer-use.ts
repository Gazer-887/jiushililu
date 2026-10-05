/**
 * computer-use 门控（plan44 S1；D-155 反转 3b）—— 能力分类与判据的单一真相源（主/渲染共读）。
 *
 * 哲学（D-155）：设置页两个能力开关 —— 「桌面操控」与「浏览器操作」。
 * 开关开 = 该类工具完整授权；关 = 该类整批不下发。COMPUTER_USE_ALLOWLIST 不再参与放行，
 * 降为风险注记表（与 COMPUTER_USE_RISKY_TOOLS 同族）：删了它会连 Process 类风险注记一起丢。
 */

/** 能力类：开关按类授权；other 类直通（普通 MCP server 不受本闸影响） */
export type CapabilityClass = 'desktop' | 'browser' | 'other'

// 桌面动词表（plan59 B1-a 步 1；keyboard 为 SendKey 类工具补）。
const DESKTOP_VERBS = ['click', 'type', 'screenshot', 'key', 'window', 'screen', 'mouse', 'keyboard']
// 浏览器信号表（同上）。⚠️ windows-mcp 例外见分类函数——它是产品专名，走子串。
const BROWSER_TOKENS = ['browser', 'playwright', 'puppeteer', 'chrome', 'edge']
const BROWSER_TOOL_SUBSTRINGS = ['navigate_page', 'list_pages', 'select_page', 'take_snapshot']

function tokensOf(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * 能力分类（纯函数，单测钉死）。匹配一律按词元来 —— 子串匹配会把 chromadb
 * 判成浏览器类（D-155 的核心恐惧：普通 server 被拦光）；唯一的例外是 windows-mcp，
 * 它是产品专名（推荐卡写入的就是这个命名），子串命中即桌面类。
 * 优先级：windows-mcp > 浏览器特征 > 桌面动词（browser-use 又 click 又 navigate_page 时归 browser）。
 */
export function classifyCapability(serverName: string, launchHint: string, toolName: string): CapabilityClass {
  const serverHay = `${serverName} ${launchHint}`.toLowerCase()
  if (serverHay.includes('windows-mcp')) return 'desktop'
  const toks = new Set([...tokensOf(serverName), ...tokensOf(launchHint), ...tokensOf(toolName)])
  const hasAny = (words: string[]): boolean => words.some((w) => toks.has(w))
  const toolLower = toolName.toLowerCase()
  if (
    hasAny(BROWSER_TOKENS) ||
    BROWSER_TOOL_SUBSTRINGS.some((n) => toolLower.includes(n)) ||
    toolLower.startsWith('browser_')
  ) {
    return 'browser'
  }
  if (hasAny(DESKTOP_VERBS)) return 'desktop'
  return 'other'
}

/**
 * 整 server 定级（设置页"被拦列表"用）：server 自身信号＋它全部工具名里最强的一档。
 * 单个工具的放行仍走 classifyCapability（装配时逐工具判）。
 */
export function classifyServer(serverName: string, launchHint: string, toolNames: string[]): CapabilityClass {
  const rank: CapabilityClass[] = ['other', 'desktop', 'browser']
  let best: CapabilityClass = classifyCapability(serverName, launchHint, '')
  for (const t of toolNames) {
    const c = classifyCapability(serverName, launchHint, t)
    if (rank.indexOf(c) > rank.indexOf(best)) best = c
  }
  return best
}

/** 放行清单（决策 3 存档；D-155 起不再参与放行判断，降为风险注记表 —— 删了它会连 Process 类注记一起丢） */
export const COMPUTER_USE_ALLOWLIST: readonly string[] = [
  'Screenshot',
  'Snapshot',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'App',
  'MultiSelect',
  'MultiEdit',
  'Clipboard',
  'Notification',
  'Process'
]

/** 描述里必须带风险标注的放行项 */
export const COMPUTER_USE_RISKY_TOOLS: readonly string[] = ['Process']
export const PROCESS_RISK_NOTE = '⚠️ 可终止任意进程，破坏力真实 —— 调用前必须向用户说明目标。'

/**
 * 主屏强制（O2 裁决的落地修正）：上游文档实证 `display` 是**工具参数**而非启动参数
 * （启动只有 --transport/--tools 等），故在门控侧按 inputSchema 如实覆写：
 * array → [0]，integer/number → 0，schema 里没有 display 参数就不动（不猜）。
 */
export function forceMainDisplay(
  inputSchema: Record<string, unknown> | undefined,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const props = inputSchema?.properties as
    | Record<string, { type?: string }>
    | undefined
  const d = props?.display
  if (!d) return payload
  if (d.type === 'array') return { ...payload, display: [0] }
  if (d.type === 'integer' || d.type === 'number') return { ...payload, display: 0 }
  return payload
}

/** 桌面派 server 识别已并入门控分类（D-155）：沿用本文件的 classifyCapability，不要各写一套 */
export type GateDecision = 'keep' | 'drop-server-off'

/** 纯门控判据（单测钉死）：other 类直通；能力类按"该类开关"整体下发/拦截（D-155：开关开 = 完整授权） */
export function gateComputerUseTool(args: {
  capability: CapabilityClass
  enabled: boolean
}): GateDecision {
  if (args.capability === 'other') return 'keep'
  return args.enabled ? 'keep' : 'drop-server-off'
}
